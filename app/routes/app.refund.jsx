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

  // ✅ Fetch refunded item data
  let refundedItems = [];
  let refundedQtyMap = {};
  let refundedShippingAmount = 0;
  let refundReasons = [];

  if (selectedOrderId && selectedOrder) {
    try {
      const refundRes = await fetch(`https://phpstack-1419716-5486887.cloudwaysapps.com/refunded-products/${selectedOrder.orderId}`);
      const result = await refundRes.json();
      refundedItems = result.refundedItems || [];
      refundedQtyMap = result.refundedQtyMap || {};
      refundedShippingAmount = result.refundedShippingAmount || 0;
    } catch (err) {
      console.warn("Could not fetch refunded item data", err);
    }

    // 🧾 Fetch all refund transactions for reason tracking (note fields)
    try {
      const txns = await admin.rest.get({ path: `/admin/api/2023-10/orders/${selectedOrder.orderId}/refunds.json` });
      const refunds = txns?.body?.refunds || [];
      refundReasons = refunds.map(r => ({
        note: r.note,
        transactions: r.transactions.map(t => ({
          amount: t.amount,
          gateway: t.gateway,
          id: t.id,
        }))
      }));
    } catch (e) {
      console.warn("Refund notes fetch failed");
    }
  }

  return json({
    orders: paginatedOrders,
    total: filteredOrders.length,
    page,
    selectedOrder,
    refundedItems,
    refundedQtyMap,
    refundedShippingAmount,
    refundReasons
  });
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
        transactions: isCalculation ? undefined : [
          {
            parent_id: input.transactionId,
            amount: input.totalAmount,
            kind: "refund",
            gateway: input.gateway,
          }
        ],
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
    if (!res.ok) throw new Error(result.error || "Refund failed");
    return json(result);
  } catch (err) {
    console.error("❌ Refund Error:", err);
    return json({ error: "Refund failed." }, { status: 500 });
  }
};







import {
  Page, Layout, Card, Text, Box, Button, TextField,
  IndexTable, Pagination, Thumbnail, Grid
} from "@shopify/polaris";
import { useLoaderData, useSearchParams, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";

export default function RefundPage() {
  const {
    orders, total, page, selectedOrder,
    refundedItems, refundedQtyMap,
    refundedShippingAmount, refundReasons
  } = useLoaderData();

  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [shippingRefundSelected, setShippingRefundSelected] = useState(false);
  const [shippingRefundAmount, setShippingRefundAmount] = useState("0.00");
  const [reasonForRefund, setReasonForRefund] = useState("");
  const [emailCustomer, setEmailCustomer] = useState(true);
  const [refundMeta, setRefundMeta] = useState(null);
  const [filter, setFilter] = useState("");
  const fetcher = useFetcher();
  const totalPages = Math.ceil(total / 25);

  useEffect(() => {
    if (selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount) {
      const original = parseFloat(selectedOrder.shippingLines.edges[0].node.originalPriceSet.shopMoney.amount);
      const remaining = Math.max(0, original - refundedShippingAmount);
      setShippingRefundAmount(remaining.toFixed(2));
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

  const subtotal = selectedProducts.reduce((sum, item) => sum + (item.quantity * parseFloat(item.price)), 0);
  const taxAmount = parseFloat(selectedOrder?.totalTaxSet?.shopMoney?.amount || 0);
  const shippingRefundValue = shippingRefundSelected ? parseFloat(shippingRefundAmount) : 0;
  const refundTotal = subtotal + taxAmount + shippingRefundValue;

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

  const handleCalculateRefund = () => {
    const formData = new FormData();
    formData.append("body", JSON.stringify({ ...preparePayload(), mode: "calculate" }));
    fetcher.submit(formData, { method: "POST" });
  };

  const handleRefund = async () => {
    const { metafields } = selectedOrder;
    const confirmText = `Refunding ${refundMeta?.amount || refundTotal}?\nTxn: ${refundMeta?.transaction_id || "?"}\nGateway: ${selectedOrder.gateway}`;
    if (!window.confirm(confirmText)) return;

    const mode = metafields?.payment_mode?.toLowerCase();
    const transactionId = metafields?.transaction_id_number;
    const amount = refundMeta.amount;
    const payload = preparePayload();

    if (mode === "paypal") {
      const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/paypal-refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId, amount })
      });
      const data = await res.json();
      if (!data.success) return alert(data.message);
      payload.variables.input.note = `Refunded via PayPal: ${data.paypalRefundId}`;
    }

    if (mode === "stripe") {
      const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/stripe-refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chargeId: transactionId, amount })
      });
      const data = await res.json();
      if (!data.success) return alert(data.message);
      payload.variables.input.note = `Refunded via Stripe: ${data.stripeRefundId}`;
    }

    const formData = new FormData();
    formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
    fetcher.submit(formData, { method: "POST" });

    setTimeout(() => goBack(), 1000);
  };

  return (
    <Page fullWidth>
      <div style={{ padding: 20 }}>
        {selectedOrder ? (
          <>
            <Button onClick={goBack}>&larr; Back to Order List</Button>

            {/* ✅ Removed Block */}
            {refundedItems.length > 0 && (
              <Card title="Removed (Already Refunded)" sectioned>
                {refundedItems.map((item, idx) => (
                  <Box key={idx} paddingBlock="200" display="flex" justifyContent="space-between">
                    <Box>
                      <Text fontWeight="bold">{item.title}</Text>
                      <Text variant="bodySm">SKU: {item.sku}</Text>
                      <Text variant="bodySm">
                        {item.price} × {item.quantity_refunded} = ${(item.price * item.quantity_refunded).toFixed(2)}
                      </Text>
                    </Box>
                    <Text color="critical">Refunded</Text>
                  </Box>
                ))}
                {refundedShippingAmount > 0 && (
                  <Box paddingBlock="200" display="flex" justifyContent="space-between">
                    <Text>Shipping</Text>
                    <Text color="critical">-${refundedShippingAmount.toFixed(2)}</Text>
                  </Box>
                )}
              </Card>
            )}

            {/* ✅ Refundable Items */}
            <Card title="Items to Refund" sectioned>
              {selectedOrder.lineItems.map(item => {
                const refundedQty = parseInt(refundedQtyMap[item.id]) || 0;
                const maxQty = item.quantity - refundedQty;
                if (maxQty <= 0) return null;

                const selected = selectedProducts.find(p => p.id === item.id);
                const qty = selected?.quantity || 0;

                return (
                  <Box key={item.id} display="flex" alignItems="center" paddingBlock="200">
                    <Thumbnail source={item.image?.originalSrc} alt={item.image?.altText} size="small" />
                    <Box paddingInlineStart="200" flexGrow={1}>
                      <Text fontWeight="bold">{item.title}</Text>
                      <Text variant="bodySm">{item.sku}</Text>
                      <Text variant="bodySm">
                        ${item.discountedUnitPriceSet.shopMoney.amount} × {maxQty}
                      </Text>
                    </Box>
                    <input
                      type="number"
                      min="0"
                      max={maxQty}
                      value={qty}
                      onChange={e => {
                        const val = parseInt(e.target.value) || 0;
                        setSelectedProducts(prev => {
                          const filtered = prev.filter(p => p.id !== item.id);
                          return val > 0 ? [...filtered, { id: item.id, title: item.title, quantity: val, price: item.discountedUnitPriceSet.shopMoney.amount }] : filtered;
                        });
                      }}
                      style={{ width: "60px" }}
                    />
                  </Box>
                );
              })}
            </Card>

            {/* ✅ Shipping Refund */}
            {parseFloat(shippingRefundAmount) > 0 && (
              <Card title="Refund Shipping" sectioned>
                <Box display="flex" alignItems="center" gap="300">
                  <input
                    type="checkbox"
                    checked={shippingRefundSelected}
                    onChange={e => setShippingRefundSelected(e.target.checked)}
                  />
                  <Text>Shipping (${shippingRefundAmount})</Text>
                </Box>
              </Card>
            )}

            {/* ✅ Refund Reason */}
            <Card title="Reason for Refund" sectioned>
              <TextField
                value={reasonForRefund}
                onChange={setReasonForRefund}
                multiline={2}
                placeholder="Staff note only"
              />
            </Card>

            {/* ✅ Summary Box (Shopify Style) */}
            <Card title="Summary" sectioned>
              <Box display="flex" justifyContent="space-between"><Text>Subtotal</Text><Text>${subtotal.toFixed(2)}</Text></Box>
              <Box display="flex" justifyContent="space-between"><Text>Tax</Text><Text>${taxAmount.toFixed(2)}</Text></Box>
              <Box display="flex" justifyContent="space-between"><Text>Shipping</Text><Text>${shippingRefundValue.toFixed(2)}</Text></Box>
              <Box display="flex" justifyContent="space-between" paddingBlockStart="300"><Text fontWeight="bold">Total</Text><Text fontWeight="bold">${refundTotal.toFixed(2)}</Text></Box>
              <Box paddingBlockStart="200"><Button fullWidth variant="secondary" onClick={handleCalculateRefund} disabled={selectedProducts.length === 0}>Calculate Refund</Button></Box>
              <Box paddingBlockStart="300"><Button fullWidth variant="primary" onClick={handleRefund} disabled={!refundMeta}>Refund ${refundMeta?.amount || refundTotal.toFixed(2)}</Button></Box>
            </Card>

            {/* ✅ Paid > Refunded Reason Summary */}
            {refundReasons.length > 0 && (
              <Card title="Paid → Refunded" sectioned>
                {refundReasons.map((r, i) => (
                  <Box key={i} paddingBlock="200">
                    <Text>{r.note}</Text>
                    {r.transactions.map((t, j) => (
                      <Text key={j} color="critical">- ${parseFloat(t.amount).toFixed(2)} ({t.gateway})</Text>
                    ))}
                  </Box>
                ))}
              </Card>
            )}
          </>
        ) : (
          <Layout.Section>
            <Card>
              <Box paddingBlockEnd="300">
                <TextField
                  label="Search orders by number or email"
                  value={filter}
                  onChange={(val) => {
                    setFilter(val);
                    setSearchParams({ search: val, page: 1 });
                  }}
                  autoComplete="off"
                  placeholder="Search #5521, email etc"
                />
              </Box>

              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={orders.length}
                selectedItemsCount={0}
                headings={[
                  { title: "Order Name" },
                  { title: "Order ID" },
                  { title: "Email" },
                  { title: "Date" },
                  { title: "Total" },
                  { title: "Payment Status" }
                ]}
              >
                {orders.map((order, index) => (
                  <IndexTable.Row id={order.id} key={order.id} position={index}>
                    <IndexTable.Cell><Button variant="plain" onClick={() => showOrder(order.id)}>{order.name}</Button></IndexTable.Cell>
                    <IndexTable.Cell>{order.orderId}</IndexTable.Cell>
                    <IndexTable.Cell>{order.email}</IndexTable.Cell>
                    <IndexTable.Cell>{new Date(order.createdAt).toLocaleString()}</IndexTable.Cell>
                    <IndexTable.Cell>{order.totalPriceSet.shopMoney.amount} {order.totalPriceSet.shopMoney.currencyCode}</IndexTable.Cell>
                    <IndexTable.Cell>{order.displayFinancialStatus || "Unknown"}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              <Box padding="300" display="flex" justifyContent="end">
                <Pagination
                  hasPrevious={page > 1}
                  hasNext={page < totalPages}
                  onPrevious={() => updatePage(page - 1)}
                  onNext={() => updatePage(page + 1)}
                />
              </Box>
            </Card>
          </Layout.Section>
        )}
      </div>
    </Page>
  );
}












