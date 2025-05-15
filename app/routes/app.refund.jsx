import {
  Page, Layout, Card, Text, Box, Button, TextField,
  IndexTable, Pagination, Thumbnail, Grid, Spinner
} from "@shopify/polaris";
import { useLoaderData, useSearchParams, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// ✅ Loader Function
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.toLowerCase().trim() || "";
  const page = parseInt(url.searchParams.get("page") || "1");
  const selectedOrderId = url.searchParams.get("orderId");

  const PAGE_SIZE = 25;
  let hasNextPage = true;
  let afterCursor = null;
  const allOrders = [];

  while (hasNextPage && allOrders.length < 1000) {
    const response = await admin.graphql(`
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
    `, { variables: { first: 250, after: afterCursor } });

    const data = await response.json();
    const orders = data.data.orders.edges;

    for (const { node, cursor } of orders) {
      if (node.sourceName !== "web") {
        const orderIdNum = node.id.split("/").pop();
        let transactionId = null, gateway = "manual", locationId = 70116966605;

        try {
          const txResp = await admin.rest.get({
            path: `/admin/api/2023-10/orders/${orderIdNum}/transactions.json`
          });
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
        node.metafields.edges.forEach(({ node: meta }) => {
          metafields[meta.key] = meta.value;
        });

        // Only fetch refund history if this is the selected order
        let refundHistory = [];
        if (selectedOrderId === node.id) {
          try {
            const refundRes = await fetch(
              `https://phpstack-1419716-5486887.cloudwaysapps.com/refunds/${orderIdNum}`
            );
            const refundData = await refundRes.json();
            refundHistory = refundData.refunds || [];
          } catch (err) {
            console.warn("Failed to load refund history:", err);
          }
        }

        allOrders.push({
          ...node,
          cursor,
          lineItems: node.lineItems.edges.map(({ node: item }) => item),
          orderId: orderIdNum,
          transactionId,
          gateway,
          locationId,
          metafields,
          refundHistory
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

  const paginatedOrders = filteredOrders.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE
  );
  const selectedOrder = selectedOrderId 
    ? allOrders.find(o => o.id === selectedOrderId) 
    : null;

  return json({ 
    orders: paginatedOrders, 
    total: filteredOrders.length, 
    page, 
    selectedOrder 
  });
};

// ✅ Action Function
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

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || "Refund failed");
    }

    const result = await res.json();
    return json(result);
  } catch (err) {
    console.error("Refund Error:", err);
    return json({ 
      error: err.message || "Refund processing failed" 
    }, { status: 500 });
  }
};

// ✅ Main Component
export default function RefundPage() {
  const { orders, total, page, selectedOrder: initialSelectedOrder } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [shippingRefundSelected, setShippingRefundSelected] = useState(false);
  const [shippingRefundAmount, setShippingRefundAmount] = useState("0.00");
  const [reason, setReason] = useState("");
  const [emailCustomer, setEmailCustomer] = useState(true);
  const [refundMeta, setRefundMeta] = useState(null);
  const [filter, setFilter] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(initialSelectedOrder);
  const [refundHistory, setRefundHistory] = useState(initialSelectedOrder?.refundHistory || []);
  const fetcher = useFetcher();

  const totalPages = Math.ceil(total / 25);

  // Filter out fully refunded items
  const getAvailableItems = () => {
    if (!selectedOrder?.lineItems) return [];
    
    const refundedQuantities = {};
    refundHistory.forEach(refund => {
      refund.refund_line_items?.forEach(item => {
        const lineId = item.line_item?.id;
        if (lineId) {
          refundedQuantities[lineId] = (refundedQuantities[lineId] || 0) + (item.quantity || 0);
        }
      });
    });

    return selectedOrder.lineItems
      .map(item => {
        const refundedQty = refundedQuantities[item.id] || 0;
        const remainingQty = Math.max(0, item.quantity - refundedQty);
        return remainingQty > 0 ? { ...item, quantity: remainingQty } : null;
      })
      .filter(Boolean);
  };

  const availableItems = getAvailableItems();

  // Handle refresh
  const handleRefresh = async () => {
    if (!selectedOrder) return;
    
    setIsRefreshing(true);
    try {
      const orderIdNum = selectedOrder.id.split("/").pop();
      const response = await fetch(
        `https://phpstack-1419716-5486887.cloudwaysapps.com/refunds/${orderIdNum}`
      );
      const data = await response.json();
      
      setRefundHistory(data.refunds || []);
      
      // Update selected products to remove any that are now fully refunded
      setSelectedProducts(prev => 
        prev.filter(p => 
          availableItems.some(item => item.id === p.id)
        )
      );
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Initialize when order is selected
  useEffect(() => {
    if (initialSelectedOrder) {
      setSelectedOrder(initialSelectedOrder);
      setRefundHistory(initialSelectedOrder.refundHistory || []);
      setSelectedProducts([]);
      setShippingRefundSelected(false);
      setShippingRefundAmount(
        initialSelectedOrder.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0.00"
      );
      setReason("");
      setEmailCustomer(true);
      setRefundMeta(null);
    }
  }, [initialSelectedOrder]);

  // Navigation functions
  const updatePage = (newPage) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", newPage.toString());
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

  // Calculate refund amounts
  const productSubtotal = selectedProducts.reduce(
    (sum, item) => sum + (parseFloat(item.discountedUnitPriceSet?.shopMoney?.amount || 0) * item.quantity),
    0
  );

  const taxAmount = parseFloat(selectedOrder?.totalTaxSet?.shopMoney?.amount || 0);
  const shippingAmount = shippingRefundSelected ? parseFloat(shippingRefundAmount || 0) : 0;
  const refundTotal = productSubtotal + taxAmount + shippingAmount;

  // Prepare payload for API calls
  const preparePayload = (mode) => ({
    mode,
    variables: {
      input: {
        orderId: selectedOrder?.id,
        refundLineItems: selectedProducts.map(item => ({
          lineItemId: item.id,
          quantity: item.quantity,
          price: item.discountedUnitPriceSet?.shopMoney?.amount,
          title: item.title
        })),
        shipping: shippingRefundSelected ? { 
          amount: shippingAmount 
        } : undefined,
        notifyCustomer: emailCustomer,
        note: reason || "Refund processed via app",
        totalAmount: refundMeta?.amount || refundTotal.toFixed(2),
        transactionId: refundMeta?.transaction_id || selectedOrder?.transactionId,
        gateway: selectedOrder?.gateway || "manual",
        locationId: selectedOrder?.locationId || "70116966605"
      }
    }
  });

  // Handle calculate refund
  const handleCalculate = () => {
    const formData = new FormData();
    formData.append("body", JSON.stringify(preparePayload("calculate")));
    fetcher.submit(formData, { method: "POST" });
  };

  // Handle full refund
  const handleRefund = async () => {
    if (!selectedOrder || selectedProducts.length === 0) return;
    
    const confirmation = window.confirm(
      `Process refund for $${refundTotal.toFixed(2)}?\n\n` +
      `Items: ${selectedProducts.length}\n` +
      `Shipping: $${shippingAmount.toFixed(2)}\n` +
      `Tax: $${taxAmount.toFixed(2)}`
    );
    
    if (!confirmation) return;

    const formData = new FormData();
    formData.append("body", JSON.stringify(preparePayload("refund")));
    fetcher.submit(formData, { method: "POST" });
  };

  // Handle refund result
  useEffect(() => {
    if (fetcher.data) {
      if (fetcher.data.error) {
        alert(`Error: ${fetcher.data.error}`);
      } else if (fetcher.data.transactionId) {
        setRefundMeta({
          transaction_id: fetcher.data.transactionId,
          amount: fetcher.data.amount
        });
        handleRefresh(); // Refresh after successful refund
      }
    }
  }, [fetcher.data]);

  return (
    <Page fullWidth>
      <div style={{ padding: "20px" }}>
        {selectedOrder ? (
          <>
            <Box paddingBottom="400">
              <Button onClick={goBack}>&larr; Back to orders</Button>
              <Button 
                onClick={handleRefresh}
                loading={isRefreshing}
                disabled={isRefreshing}
                style={{ marginLeft: "10px" }}
              >
                Refresh
              </Button>
            </Box>

            <Grid>
              <Grid.Cell columnSpan={{ xs: 6, sm: 8 }}>
                {/* Order Items */}
                <Card>
                  <Text variant="headingMd" as="h2">
                    Available Items for Refund
                  </Text>
                  {availableItems.length === 0 ? (
                    <Box padding="400">
                      <Text color="subdued">No items available for refund</Text>
                    </Box>
                  ) : (
                    availableItems.map(item => {
                      const selected = selectedProducts.find(p => p.id === item.id);
                      const selectedQty = selected?.quantity || 0;
                      
                      return (
                        <Box key={item.id} padding="300" display="flex" alignItems="center">
                          <Thumbnail
                            source={item.image?.originalSrc || ""}
                            alt={item.image?.altText || ""}
                            size="small"
                          />
                          <Box paddingLeft="300" flexGrow={1}>
                            <Text fontWeight="bold">{item.title}</Text>
                            <Text variant="bodySm">{item.sku}</Text>
                            <Text variant="bodySm">
                              ${item.discountedUnitPriceSet?.shopMoney?.amount} × {item.quantity}
                            </Text>
                          </Box>
                          <input
                            type="number"
                            min="0"
                            max={item.quantity}
                            value={selectedQty}
                            onChange={(e) => {
                              const qty = parseInt(e.target.value) || 0;
                              setSelectedProducts(prev => {
                                const others = prev.filter(p => p.id !== item.id);
                                return qty > 0 
                                  ? [...others, { 
                                      ...item, 
                                      quantity: Math.min(qty, item.quantity) 
                                    }]
                                  : others;
                              });
                            }}
                            style={{ width: "60px", padding: "5px" }}
                          />
                        </Box>
                      );
                    })
                  )}
                </Card>

                {/* Shipping Refund */}
                <Card sectioned>
                  <Box display="flex" alignItems="center" gap="200">
                    <input
                      type="checkbox"
                      checked={shippingRefundSelected}
                      onChange={(e) => setShippingRefundSelected(e.target.checked)}
                    />
                    <Text>Refund shipping</Text>
                    <TextField
                      type="number"
                      disabled={!shippingRefundSelected}
                      value={shippingRefundAmount}
                      onChange={setShippingRefundAmount}
                      prefix="$"
                      style={{ width: "100px", marginLeft: "auto" }}
                    />
                  </Box>
                </Card>

                {/* Refund Reason */}
                <Card sectioned>
                  <TextField
                    label="Reason for refund"
                    value={reason}
                    onChange={setReason}
                    multiline={2}
                    placeholder="Internal note (customer won't see this)"
                  />
                </Card>

                {/* Refund History */}
                <Card sectioned>
                  <Text variant="headingMd" as="h2">
                    Previous Refunds
                  </Text>
                  {refundHistory.length === 0 ? (
                    <Box padding="300">
                      <Text color="subdued">No refund history found</Text>
                    </Box>
                  ) : (
                    refundHistory.map((refund, i) => (
                      <Box key={i} padding="300" borderTop="divider">
                        <Text fontWeight="bold">
                          {new Date(refund.created_at).toLocaleString()} - ${refund.transactions?.[0]?.amount || "0.00"}
                        </Text>
                        {refund.note && <Text>{refund.note}</Text>}
                        {refund.refund_line_items?.map((item, j) => (
                          <Box key={j} paddingLeft="200" paddingTop="100">
                            <Text>
                              {item.quantity} × {item.line_item?.title} (${item.subtotal})
                            </Text>
                          </Box>
                        ))}
                      </Box>
                    ))
                  )}
                </Card>
              </Grid.Cell>

              <Grid.Cell columnSpan={{ xs: 6, sm: 4 }}>
                <Card sectioned>
                  <Text variant="headingMd" as="h2">
                    Refund Summary
                  </Text>
                  <Box padding="300">
                    <Box display="flex" justifyContent="space-between">
                      <Text>Items subtotal:</Text>
                      <Text>${productSubtotal.toFixed(2)}</Text>
                    </Box>
                    <Box display="flex" justifyContent="space-between">
                      <Text>Tax:</Text>
                      <Text>${taxAmount.toFixed(2)}</Text>
                    </Box>
                    <Box display="flex" justifyContent="space-between">
                      <Text>Shipping:</Text>
                      <Text>${shippingAmount.toFixed(2)}</Text>
                    </Box>
                    <Box 
                      display="flex" 
                      justifyContent="space-between"
                      paddingTop="200"
                      borderTop="divider"
                    >
                      <Text fontWeight="bold">Total:</Text>
                      <Text fontWeight="bold">${refundTotal.toFixed(2)}</Text>
                    </Box>

                    <Box paddingTop="400">
                      <Button
                        fullWidth
                        onClick={handleCalculate}
                        disabled={selectedProducts.length === 0}
                        loading={fetcher.state === "submitting"}
                      >
                        Calculate Refund
                      </Button>
                    </Box>

                    <Box paddingTop="200">
                      <Button
                        fullWidth
                        primary
                        onClick={handleRefund}
                        disabled={!refundMeta || selectedProducts.length === 0}
                        loading={fetcher.state === "submitting"}
                      >
                        {refundMeta 
                          ? `Refund $${refundMeta.amount}` 
                          : "Process Refund"}
                      </Button>
                    </Box>
                  </Box>
                </Card>
              </Grid.Cell>
            </Grid>
          </>
        ) : (
          <Layout.Section>
            <Card>
              <Box paddingBottom="300">
                <TextField
                  label="Search orders"
                  value={filter}
                  onChange={(value) => {
                    setFilter(value);
                    const params = new URLSearchParams();
                    params.set("search", value);
                    params.set("page", "1");
                    setSearchParams(params);
                  }}
                  placeholder="Search by order # or email"
                  autoComplete="off"
                />
              </Box>

              <IndexTable
                itemCount={orders.length}
                headings={[
                  { title: "Order" },
                  { title: "Date" },
                  { title: "Customer" },
                  { title: "Total" },
                  { title: "Status" }
                ]}
              >
                {orders.map((order, index) => (
                  <IndexTable.Row key={order.id} position={index}>
                    <IndexTable.Cell>
                      <Button plain onClick={() => showOrder(order.id)}>
                        {order.name}
                      </Button>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {new Date(order.createdAt).toLocaleDateString()}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {order.email}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      ${order.totalPriceSet?.shopMoney?.amount}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {order.displayFinancialStatus}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              {totalPages > 1 && (
                <Box paddingTop="300">
                  <Pagination
                    hasPrevious={page > 1}
                    hasNext={page < totalPages}
                    onPrevious={() => updatePage(page - 1)}
                    onNext={() => updatePage(page + 1)}
                  />
                </Box>
              )}
            </Card>
          </Layout.Section>
        )}
      </div>
    </Page>
  );
}