
// ✅ PART 1 — Loader and Action Logic
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.toLowerCase().trim() || "";
  const page = parseInt(url.searchParams.get("page")) || 1;
  const selectedOrderId = url.searchParams.get("orderId") || null;

  const PAGE_SIZE = 25;
  let hasNextPage = true;
  let afterCursor = null;
  const allOrders = [];

  while (hasNextPage && allOrders.length < 1000) {
    const query = `
      query GetOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, reverse: true) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id name email createdAt sourceName displayFinancialStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              totalTaxSet { shopMoney { amount } }
              shippingLines(first: 1) {
                edges {
                  node {
                    title
                    originalPriceSet { shopMoney { amount currencyCode } }
                  }
                }
              }
              lineItems(first: 20) {
                edges {
                  node {
                    id title quantity sku
                    image { originalSrc altText }
                    discountedUnitPriceSet { shopMoney { amount currencyCode } }
                  }
                }
              }
              metafields(first: 10, namespace: "custom") {
                edges {
                  node {
                    key value
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(query, { variables: { first: 250, after: afterCursor } });
    const data = await response.json();
    const orders = data.data.orders.edges;

    for (const { node, cursor } of orders) {
      if (node.sourceName !== "web") {
        const orderIdNum = node.id.split("/").pop();
        let transactionId = null, gateway = "manual", locationId = 70116966605;

        try {
          const txResp = await admin.rest.get({ path: `/admin/api/2023-10/orders/${orderIdNum}/transactions.json` });
          const tx = txResp?.body?.transactions?.[0];
          if (tx) {
            transactionId = tx.id;
            gateway = tx.gateway || "manual";
            locationId = tx.location_id || locationId;
          }
        } catch (e) {
          console.warn("Transaction fetch failed:", e);
        }

        const metafields = {};
        node.metafields.edges.forEach(({ node }) => {
          metafields[node.key] = node.value;
        });

        allOrders.push({
          ...node,
          cursor,
          lineItems: node.lineItems.edges.map(({ node }) => node),
          orderId: orderIdNum,
          transactionId,
          gateway,
          locationId,
          metafields
        });
      }
    }

    hasNextPage = data.data.orders.pageInfo.hasNextPage;
    afterCursor = hasNextPage ? orders[orders.length - 1].cursor : null;
  }

  const filteredOrders = allOrders.filter(order => {
    const cleanSearch = search.replace("#", "");
    return (
      order.name.toLowerCase().replace("#", "").includes(cleanSearch) ||
      order.email.toLowerCase().includes(cleanSearch)
    );
  });

  const paginatedOrders = filteredOrders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedOrder = selectedOrderId ? allOrders.find(o => o.id === selectedOrderId) : null;

  return json({ orders: paginatedOrders, total: filteredOrders.length, page, selectedOrder });
};

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();
    const body = JSON.parse(formData.get("body") || "{}");
    const isCalculation = body.mode === "calculate";
    const input = body.variables.input;
    const orderId = input.orderId.split("/").pop();

    const payload = {
      refund: {
        refund_line_items: input.refundLineItems.map(item => ({
          line_item_id: item.lineItemId.split("/").pop(),
          quantity: item.quantity,
        })),
        shipping: input.shipping ? { amount: input.shipping.amount } : undefined,
        currency: "AUD",
        notify: input.notifyCustomer,
        note: input.note || "Refund via app",
        transactions: isCalculation ? undefined : [ {
          parent_id: input.transactionId,
          amount: input.totalAmount,
          kind: "refund",
          gateway: input.gateway,
        } ],
      }
    };

    const endpoint = isCalculation
      ? "https://phpstack-1419716-5486887.cloudwaysapps.com/calculate"
      : "https://phpstack-1419716-5486887.cloudwaysapps.com/refund";

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, payload }),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Failed");
    return json(result);
  } catch (err) {
    console.error("❌ Refund Error:", err);
    return json({ error: "Refund failed." }, { status: 500 });
  }
};








// ✅ PART 2 — Complete Remix Component (UI)
import {
  Page, Layout, Card, Text, Box, Button, TextField,
  IndexTable, Pagination, Thumbnail, Grid
} from "@shopify/polaris";
import { useLoaderData, useSearchParams, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";

export default function RefundPage() {
  const { orders, total, page, selectedOrder } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [shippingRefundSelected, setShippingRefundSelected] = useState(false);
  const [shippingRefundAmount, setShippingRefundAmount] = useState("0.00");
  const [reasonForRefund, setReasonForRefund] = useState("");
  const [emailCustomer, setEmailCustomer] = useState(true);
  const [refundMeta, setRefundMeta] = useState(null);
  const [refundedItems, setRefundedItems] = useState(null);
  const [filter, setFilter] = useState("");
  const fetcher = useFetcher();
  const totalPages = Math.ceil(total / 25);

  useEffect(() => {
    if (selectedOrder) {
      setSelectedProducts([]);
      setShippingRefundSelected(false);
      setShippingRefundAmount(
        selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0.00"
      );
      setReasonForRefund("");
      setEmailCustomer(true);
      setRefundMeta(null);
      setRefundedItems(null);
    }
  }, [selectedOrder]);

  useEffect(() => {
    if (fetcher.data?.transactionId && fetcher.data?.amount) {
      setRefundMeta({
        transaction_id: fetcher.data.transactionId,
        amount: fetcher.data.amount
      });
    }
  }, [fetcher.data]);

  const updatePage = (newPage) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", newPage);
    setSearchParams(params);
  };

  const showOrder = (orderId) => {
    const params = new URLSearchParams(searchParams);
    params.set("orderId", orderId);
    setSearchParams(params);
  };

  const goBack = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("orderId");
    setSearchParams(params);
  };

  const productSubtotal = selectedProducts.reduce(
    (sum, item) => sum + (parseFloat(item.price) * item.quantity), 0
  );
  const taxAmount = parseFloat(selectedOrder?.totalTaxSet?.shopMoney?.amount || 0);
  const shippingRefundValue = shippingRefundSelected ? parseFloat(shippingRefundAmount || 0) : 0;
  const refundTotal = productSubtotal + taxAmount + shippingRefundValue;

  const preparePayload = () => ({
    mode: refundMeta ? "refund" : "calculate",
    variables: {
      input: {
        orderId: selectedOrder.id,
        refundLineItems: selectedProducts.map(item => ({
          lineItemId: item.id,
          quantity: item.quantity,
          price: item.price,
          title: item.title
        })),
        shipping: shippingRefundSelected ? { amount: shippingRefundAmount } : undefined,
        notifyCustomer: emailCustomer,
        note: reasonForRefund || "Refund processed via app",
        totalAmount: refundMeta?.amount || refundTotal,
        transactionId: refundMeta?.transaction_id || selectedOrder.transactionId,
        gateway: selectedOrder.gateway,
        locationId: selectedOrder.locationId || "70116966605"
      }
    }
  });

  const handleRefund = async () => {
    const payload = preparePayload();
    const formData = new FormData();
    formData.append("body", JSON.stringify(payload));
    fetcher.submit(formData, { method: "POST" });

    setTimeout(async () => {
      const res = await fetch(`https://phpstack-1419716-5486887.cloudwaysapps.com/get-refunds/${selectedOrder.orderId}`);
      const data = await res.json();
      if (data.success) setRefundedItems(data.refunds);
    }, 1000);
  };

  return (
    <Page fullWidth>
      <div style={{ padding: 20 }}>
        {selectedOrder ? (
          <>
            <Button onClick={goBack}>&larr; Back</Button>
            <Card>
              {selectedOrder.lineItems.map(item => {
                const selectedQty = selectedProducts.find(p => p.id === item.id)?.quantity || 0;
                return (
                  <Box key={item.id} paddingBlock="200" display="flex" alignItems="center">
                    <Thumbnail source={item.image?.originalSrc || ''} alt={item.image?.altText || ''} />
                    <Box paddingInlineStart="200" flexGrow={1}>
                      <Text>{item.title}</Text>
                      <Text variant="bodySm">SKU: {item.sku}</Text>
                      <Text variant="bodySm">${item.discountedUnitPriceSet.shopMoney.amount} × {item.quantity}</Text>
                    </Box>
                    <input
                      type="number"
                      min="0"
                      max={item.quantity}
                      value={selectedQty}
                      onChange={e => {
                        const qty = parseInt(e.target.value) || 0;
                        setSelectedProducts(prev => {
                          const filtered = prev.filter(p => p.id !== item.id);
                          if (qty > 0) {
                            return [...filtered, { id: item.id, title: item.title, quantity: qty, price: item.discountedUnitPriceSet.shopMoney.amount }];
                          } else return filtered;
                        });
                      }}
                      style={{ width: 60, marginLeft: 10 }}
                    />
                  </Box>
                );
              })}
            </Card>

            <Card title="Refund Summary" sectioned>
              <Box display="flex" justifyContent="space-between"><Text>Subtotal</Text><Text>${productSubtotal.toFixed(2)}</Text></Box>
              <Box display="flex" justifyContent="space-between"><Text>Tax</Text><Text>${taxAmount.toFixed(2)}</Text></Box>
              <Box display="flex" justifyContent="space-between"><Text>Shipping</Text><Text>${shippingRefundValue.toFixed(2)}</Text></Box>
              <Box paddingBlockStart="200" display="flex" justifyContent="space-between">
                <Text fontWeight="bold">Total</Text>
                <Text fontWeight="bold">${refundTotal.toFixed(2)}</Text>
              </Box>
              <Box paddingBlockStart="200">
                <Button fullWidth onClick={handleRefund} disabled={selectedProducts.length === 0}>
                  Refund Now
                </Button>
              </Box>
            </Card>

            {/* ✅ Refunded Items Section */}
            {refundedItems && refundedItems.length > 0 && (
              <Card title="Refunded Items" sectioned>
                {refundedItems.map((refund, i) => (
                  <div key={i}>
                    {refund.refund_line_items.map((item, idx) => (
                      <Box key={idx} paddingBlock="200">
                        <Text variant="headingSm">{item.title}</Text>
                        <Text variant="bodySm">SKU: {item.sku} | Qty: {item.quantity} | Tax: ${item.total_tax}</Text>
                      </Box>
                    ))}
                    {refund.refund_shipping?.length > 0 && (
                      <Box paddingBlock="200">
                        <Text variant="headingSm">Shipping Refunded</Text>
                        {refund.refund_shipping.map((ship, sidx) => (
                          <Text key={sidx} variant="bodySm">
                            {ship.title} — ${ship.total} (Tax: ${ship.tax})
                          </Text>
                        ))}
                      </Box>
                    )}
                  </div>
                ))}
              </Card>
            )}
          </>
        ) : (
          <Card>
            <TextField
              label="Search Orders"
              value={filter}
              onChange={(val) => {
                setFilter(val);
                setSearchParams({ search: val, page: 1 });
              }}
              placeholder="Search order number or email"
            />
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={orders.length}
              selectedItemsCount={0}
              headings={[
                { title: "Order" },
                { title: "ID" },
                { title: "Email" },
                { title: "Date" },
                { title: "Total" },
                { title: "Status" }
              ]}
            >
              {orders.map((order, index) => (
                <IndexTable.Row id={order.id} key={order.id} position={index}>
                  <IndexTable.Cell><Button variant="plain" onClick={() => showOrder(order.id)}>{order.name}</Button></IndexTable.Cell>
                  <IndexTable.Cell>{order.orderId}</IndexTable.Cell>
                  <IndexTable.Cell>{order.email}</IndexTable.Cell>
                  <IndexTable.Cell>{new Date(order.createdAt).toLocaleString()}</IndexTable.Cell>
                  <IndexTable.Cell>{order.totalPriceSet.shopMoney.amount}</IndexTable.Cell>
                  <IndexTable.Cell>{order.displayFinancialStatus || "N/A"}</IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
            <Box paddingBlockStart="300" display="flex" justifyContent="end">
              <Pagination
                hasPrevious={page > 1}
                hasNext={page < totalPages}
                onPrevious={() => updatePage(page - 1)}
                onNext={() => updatePage(page + 1)}
              />
            </Box>
          </Card>
        )}
      </div>
    </Page>
  );
}











