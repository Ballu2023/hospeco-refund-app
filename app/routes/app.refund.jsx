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
              lineItems(first: 50) {
                edges {
                  node {
                    id title quantity sku
                    image { originalSrc altText }
                    discountedUnitPriceSet { shopMoney { amount currencyCode } }
                  }
                }
              }
              metafields(first: 20, namespace: "custom") {
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

        const refundMap = metafields?.refund_quantity_map ? JSON.parse(metafields.refund_quantity_map) : {};

        const lineItems = node.lineItems.edges.map(({ node }) => {
          const refundedQty = refundMap[node.id] || 0;
          return {
            ...node,
            refundedQuantity: refundedQty,
            remainingQuantity: node.quantity - refundedQty
          };
        });

        const fullyRefunded = lineItems.every(item => item.remainingQuantity <= 0);

        allOrders.push({
          ...node,
          cursor,
          lineItems,
          orderId: orderIdNum,
          transactionId,
          gateway,
          locationId,
          metafields,
          fullyRefunded
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
        transactions: isCalculation ? undefined : [{
          parent_id: input.transactionId,
          amount: input.totalAmount,
          kind: "refund",
          gateway: input.gateway,
        }],
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
    if (!res.ok) throw new Error(result.error || "Refund failed.");
    return json(result);
  } catch (err) {
    console.error("❌ Refund Error:", err);
    return json({ error: "Refund failed." }, { status: 500 });
  }
};





// ✅ FINAL UI (React Component) WITH ALL FIXES
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
  const [refundedItems, setRefundedItems] = useState({});
  const [filter, setFilter] = useState("");
  const fetcher = useFetcher();

  // ✅ Reset state on new order load
  useEffect(() => {
    if (selectedOrder) {
      const newShippingAmount = selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0.00";
      setShippingRefundAmount(newShippingAmount);
      setShippingRefundSelected(false);
      setSelectedProducts([]);
      setRefundMeta(null);
    }
  }, [selectedOrder]);

  // ✅ Auto calculate refund on selection
  useEffect(() => {
    if (selectedProducts.length > 0 || shippingRefundSelected) {
      const formData = new FormData();
      formData.append("body", JSON.stringify({ ...preparePayload(), mode: "calculate" }));
      fetcher.submit(formData, { method: "POST" });
    }
  }, [selectedProducts, shippingRefundSelected]);

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

  const updateRefundedQuantities = (lineItemId, quantity) => {
    setRefundedItems(prev => ({
      ...prev,
      [lineItemId]: (prev[lineItemId] || 0) + quantity,
    }));
  };

  const markItemsAsRefunded = () => {
    selectedProducts.forEach(item => {
      updateRefundedQuantities(item.id, item.quantity);
    });
  };

  const refundedItemsList = selectedOrder?.lineItems?.filter(item =>
    (refundedItems[item.id] || 0) >= item.quantity
  ) || [];

  const availableForRefundList = selectedOrder?.lineItems?.filter(item =>
    (refundedItems[item.id] || 0) < item.quantity
  ) || [];

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
    if (selectedProducts.length === 0 || !refundMeta) return alert("No products selected for refund");

    const { metafields } = selectedOrder;
    const summary = `\n🧾 Refund Summary:\n\n` +
      selectedProducts.map(p => `• ${p.title} (Qty: ${p.quantity} × $${p.price})`).join("\n") +
      (shippingRefundSelected ? `\n• Shipping: $${parseFloat(shippingRefundAmount).toFixed(2)}` : "") +
      `\n• Tax: $${taxAmount.toFixed(2)}` +
      `\n• Total Refund: $${refundMeta.amount}` +
      `\n\n📌 Payment Info:\n` +
      `• Mode: ${metafields?.payment_mode || "N/A"}\n` +
      `• Txn ID: ${metafields?.transaction_id_number || "N/A"}` +
      `\n\nClick OK to continue with the refund.`;

    if (!window.confirm(summary)) return;

    const paymentMode = metafields?.payment_mode?.toLowerCase();
    const transactionId = metafields?.transaction_id_number;
    const amount = refundMeta.amount;

    const payload = preparePayload();

    try {
      if (paymentMode === 'paypal') {
        const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/paypal-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, amount })
        });
        const data = await res.json();
        if (!data.success) return alert("❌ PayPal refund failed: " + data.message);
        payload.variables.input.note = `Refunded via PayPal: ${data.paypalRefundId}`;
      } else if (paymentMode === 'stripe') {
        const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/stripe-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chargeId: transactionId, amount })
        });
        const data = await res.json();
        if (!data.success) return alert("❌ Stripe refund failed: " + data.message);
        payload.variables.input.note = `Refunded via Stripe: ${data.stripeRefundId}`;
      }

      const formData = new FormData();
      formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
      fetcher.submit(formData, { method: "POST" });
      markItemsAsRefunded();

      setTimeout(() => {
        alert(`\n✅ Refund Successful!\n\nAmount: $${amount}\nTxn: ${refundMeta.transaction_id}`);
        goBack();
      }, 800);

    } catch (err) {
      alert("❌ Refund error: " + err.message);
    }
  };

  return (
    <Page fullWidth>
      <div style={{ padding: 20 }}>
        {selectedOrder ? (
          <>
            <Button onClick={goBack}>&larr; Back to Order List</Button>
            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 8 }}>
                <Card title="Order Line Items (Available for Refund)">
                  {availableForRefundList.map(item => {
                    const alreadyRefunded = refundedItems[item.id] || 0;
                    const remainingQty = item.quantity - alreadyRefunded;
                    const existing = selectedProducts.find(p => p.id === item.id);
                    const selectedQuantity = existing?.quantity || 0;

                    return (
                      <Box key={item.id} display="flex" alignItems="center" paddingBlock="300">
                        <Thumbnail
                          source={item.image?.originalSrc || "https://cdn.shopify.com/s/files/1/0752/6435/6351/files/no-image-icon.png"}
                          alt={item.image?.altText || "Product image"}
                          size="small"
                        />
                        <Box paddingInlineStart="300" flexGrow={1}>
                          <Text fontWeight="bold">{item.title}</Text>
                          <Text variant="bodySm">{item.sku}</Text>
                          <Text variant="bodySm">
                            ${item.discountedUnitPriceSet.shopMoney.amount} × {remainingQty}
                          </Text>
                        </Box>
                        <input
                          type="number"
                          min="0"
                          max={remainingQty}
                          value={selectedQuantity}
                          onChange={(e) => {
                            const qty = parseInt(e.target.value) || 0;
                            setSelectedProducts(prev => {
                              const withoutThis = prev.filter(p => p.id !== item.id);
                              if (qty > 0) {
                                return [...withoutThis, {
                                  id: item.id,
                                  title: item.title,
                                  quantity: qty,
                                  price: item.discountedUnitPriceSet.shopMoney.amount
                                }];
                              } else {
                                return withoutThis;
                              }
                            });
                          }}
                          style={{ width: "50px", marginLeft: "10px" }}
                        />
                      </Box>
                    );
                  })}
                </Card>

                {refundedItemsList.length > 0 && (
                  <Card title="Already Refunded Items" sectioned>
                    {refundedItemsList.map(item => (
                      <Box key={item.id} display="flex" alignItems="center" paddingBlock="300">
                        <Thumbnail
                          source={item.image?.originalSrc || "https://cdn.shopify.com/s/files/1/0752/6435/6351/files/no-image-icon.png"}
                          alt={item.image?.altText || "Product image"}
                          size="small"
                        />
                        <Box paddingInlineStart="300">
                          <Text fontWeight="bold">{item.title}</Text>
                          <Text variant="bodySm">{item.sku}</Text>
                          <Text variant="bodySm" color="subdued">Refunded: {item.quantity} unit(s)</Text>
                        </Box>
                      </Box>
                    ))}
                  </Card>
                )}

                <Card title="Refund Shipping" sectioned>
                  <Box display="flex" alignItems="center" gap="300">
                    <input
                      type="checkbox"
                      checked={shippingRefundSelected}
                      onChange={e => setShippingRefundSelected(e.target.checked)}
                    />
                    <Text>Freight - ${shippingRefundAmount}</Text>
                    <input
                      type="text"
                      disabled={!shippingRefundSelected}
                      value={shippingRefundAmount}
                      onChange={e => setShippingRefundAmount(e.target.value)}
                      style={{ marginLeft: "auto", width: 100, padding: 5 }}
                    />
                  </Box>
                </Card>

                <Card title="Reason for Refund" sectioned>
                  <TextField
                    value={reasonForRefund}
                    onChange={setReasonForRefund}
                    multiline={2}
                    placeholder="Only you and staff can see this reason"
                  />
                </Card>
              </Grid.Cell>

              <Grid.Cell columnSpan={{ xs: 6, sm: 4 }}>
                <Card title="Summary" sectioned>
                  <Box display="flex" justifyContent="space-between">
                    <Text>Item subtotal</Text>
                    <Text>${productSubtotal.toFixed(2)}</Text>
                  </Box>
                  <Box display="flex" justifyContent="space-between" paddingBlockStart="100">
                    <Text>Tax</Text>
                    <Text>${taxAmount.toFixed(2)}</Text>
                  </Box>
                  <Box display="flex" justifyContent="space-between" paddingBlockStart="100">
                    <Text>Shipping</Text>
                    <Text>${shippingRefundValue.toFixed(2)}</Text>
                  </Box>
                  <Box display="flex" justifyContent="space-between" paddingBlockStart="300">
                    <Text fontWeight="bold">Refund total</Text>
                    <Text fontWeight="bold">${refundTotal.toFixed(2)}</Text>
                  </Box>
                  <Box paddingBlockStart="300">
                    <Button fullWidth variant="primary" onClick={handleRefund} disabled={!refundMeta || selectedProducts.length === 0}>
                      {refundMeta
                        ? `Refund $${refundMeta.amount} (TX: ${refundMeta.transaction_id})`
                        : `Refund $${refundTotal.toFixed(2)}`}
                    </Button>
                  </Box>
                </Card>
              </Grid.Cell>
            </Grid>
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
                    <IndexTable.Cell>
                      <Button variant="plain" onClick={() => showOrder(order.id)}>
                        {order.name}
                      </Button>
                    </IndexTable.Cell>
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
                  hasNext={page < Math.ceil(total / 25)}
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











