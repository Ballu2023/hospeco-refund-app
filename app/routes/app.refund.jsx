// ✅ app/routes/app.refund.jsx — LOADER and ACTION
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
              customer {
                firstName
                lastName
                email
              }
              shippingLines(first: 1) {
                edges {
                  node {
                    title
                    originalPriceSet { shopMoney { amount currencyCode } }
                    taxLines { price rate title }
                  }
                }
              }
              lineItems(first: 20) {
                edges {
                  node {
                    id title quantity sku
                    image { originalSrc altText }
                    discountedUnitPriceSet { shopMoney { amount currencyCode } }
                    taxLines { price rate title }
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

    if (!data?.data) {
      console.error("❌ GraphQL Error:", JSON.stringify(data, null, 2));
      throw new Error("Failed to fetch orders");
    }

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

        let lineItems = node.lineItems.edges.map(({ node }) => node);

        const selectedOrderNum = selectedOrderId?.split("/").pop();
        if (selectedOrderNum === orderIdNum) {
          try {
            const refundRes = await fetch(`https://phpstack-1419716-5486887.cloudwaysapps.com/refunds/${orderIdNum}`);
            const refundJson = await refundRes.json();

            const refundedMap = {};
            refundJson.refunds?.forEach(refund => {
              refund.refund_line_items.forEach(refItem => {
                const plainId = refItem.line_item_id?.toString();
                if (plainId) {
                  refundedMap[plainId] = (refundedMap[plainId] || 0) + refItem.quantity;
                }
              });
            });

            lineItems = lineItems
              .map(item => {
                const itemIdPlain = item.id.split("/").pop();
                const refundedQty = refundedMap[itemIdPlain] || 0;
                const remainingQty = item.quantity - refundedQty;
                if (remainingQty <= 0) return null;
                return { ...item, quantity: remainingQty };
              })
              .filter(Boolean);
          } catch (err) {
            console.error("❌ Failed to fetch refund data:", err);
          }
        }

        const customerName = `${node.customer?.firstName || ""} ${node.customer?.lastName || ""}`.trim();
        const customerEmail = node.customer?.email || node.email;

        allOrders.push({
          ...node,
          cursor,
          lineItems,
          orderId: orderIdNum,
          transactionId,
          gateway,
          locationId,
          metafields,
          customerName,
          customerEmail
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
      order.customerEmail.toLowerCase().includes(cleanSearch)
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
    if (!res.ok) throw new Error(result.error || "Failed");
    return json(result);
  } catch (err) {
    console.error("❌ Refund Error:", err);
    return json({ error: "Refund failed." }, { status: 500 });
  }
};








// ✅ app/routes/app.refund.jsx — Full Remix UI Code (Polaris + Refund Logic)

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
  const [filter, setFilter] = useState("");
  const [refundHistory, setRefundHistory] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
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

  useEffect(() => {
    const fetchRefundHistory = async () => {
      if (!selectedOrder) return;
      setLoadingHistory(true);
      try {
        const orderIdNum = selectedOrder.id.split("/").pop();
        const res = await fetch(`https://phpstack-1419716-5486887.cloudwaysapps.com/refunds/${orderIdNum}`);
        const data = await res.json();
        setRefundHistory(data.refunds || []);
      } catch (err) {
        console.error("❌ Error fetching refund history:", err);
        setRefundHistory([]);
      } finally {
        setLoadingHistory(false);
      }
    };
    fetchRefundHistory();
  }, [selectedOrder]);


  // 🆕 Add this useEffect to compute remaining shipping dynamically
useEffect(() => {
  if (!selectedOrder || !refundHistory) return;

  let totalShippingRefunded = 0;

  refundHistory.forEach(refund => {
    refund.refund_shipping_lines?.forEach(ship => {
      const refundedAmount = parseFloat(ship.subtotal_amount_set?.shop_money?.amount || 0);
      totalShippingRefunded += refundedAmount;
    });
  });

  const originalShipping = parseFloat(
    selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0"
  );

  const remainingShipping = Math.max(originalShipping - totalShippingRefunded, 0).toFixed(2);
  setShippingRefundAmount(remainingShipping);
}, [refundHistory, selectedOrder]);


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

  const fullOrderTax = parseFloat(selectedOrder?.totalTaxSet?.shopMoney?.amount || 0);

const shippingTaxValue = parseFloat(
  selectedOrder?.shippingLines?.edges?.[0]?.node?.taxLines?.[0]?.price || "0"
);
const shippingTax = shippingRefundSelected ? shippingTaxValue : 0;

const fullSubtotal = selectedOrder?.lineItems?.reduce(
  (sum, item) =>
    sum + parseFloat(item.discountedUnitPriceSet?.shopMoney?.amount || 0) * item.quantity,
  0
);

const productSubtotal = selectedProducts.reduce(
  (sum, item) => sum + (parseFloat(item.price) * item.quantity), 0
);

const productTax = productSubtotal > 0 && fullSubtotal > 0
  ? (fullOrderTax - shippingTaxValue) * (productSubtotal / fullSubtotal)
  : 0;

const taxAmount = productTax + shippingTax;

const shippingRefundValue = shippingRefundSelected
  ? parseFloat(shippingRefundAmount || 0)
  : 0;

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

  const handleCalculateRefund = () => {
    const formData = new FormData();
    formData.append("body", JSON.stringify({ ...preparePayload(), mode: "calculate" }));
    fetcher.submit(formData, { method: "POST" });
  };

  const handleRefund = async () => {
    if (selectedProducts.length === 0 || !refundMeta) return;
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

       if (paymentMode === 'paypal') {
      try {
        const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/paypal-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, amount }),
        });

        const data = await res.json();
        if (!data.success) {
          alert("❌ PayPal refund failed: " + data.message);
          return;
        }

        const payload = preparePayload();
        payload.variables.input.note = `Refunded via PayPal: ${data.paypalRefundId}`;
        const formData = new FormData();
        formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
        fetcher.submit(formData, { method: "POST" });

      } catch (err) {
        alert("❌ PayPal refund error: " + err.message);
        return;
      }
    } else if (paymentMode === 'stripe') {
      try {
        const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/stripe-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chargeId: transactionId, amount })
        });

        const data = await res.json();
        if (!data.success) {
          alert("❌ Stripe refund failed: " + data.message);
          return;
        }

        const payload = preparePayload();
        payload.variables.input.note = `Refunded via Stripe: ${data.stripeRefundId}`;
        const formData = new FormData();
        formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
        fetcher.submit(formData, { method: "POST" });

      } catch (err) {
        alert("❌ Stripe refund error: " + err.message);
        return;
      }
    } else {
      const formData = new FormData();
      formData.append("body", JSON.stringify({ ...preparePayload(), mode: "refund" }));
      fetcher.submit(formData, { method: "POST" });
    }

    setTimeout(() => {
      alert(`\n✅ Refund Successful!\n\nAmount: $${amount}\nTxn: ${refundMeta.transaction_id}`);
      goBack();
    }, 800);
  };


function formatDate(dateStr) {
  const date = new Date(dateStr);
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${d}/${m}/${y} ${h}:${min}:${s}`;
}


  return (
  <Page fullWidth>
    <div style={{ padding: 20 }}>
      {selectedOrder ? (
        <>
          {/* Header */}
          <Box display="flex" justifyContent="space-between" alignItems="center" padding="400">
            <Box display="flex" alignItems="center" gap="300">
              <Text variant="headingLg" fontWeight="bold">
                #{selectedOrder?.name?.replace("#", "")}
              </Text>
              <Box style={{ backgroundColor: "#fff6d8", padding: "4px 12px", borderRadius: 8 }}>
                <Text fontWeight="medium" color="warning">
                  Unfulfilled
                </Text>
              </Box>
            </Box>
            <Box>
              <Text fontWeight="medium">{selectedOrder?.customerName || "Customer"}</Text>
            </Box>
          </Box>

          {/* Line Items */}
          <Card>
            {selectedOrder.lineItems.map((item) => {
              const selectedQty = selectedProducts.find(p => p.id === item.id)?.quantity || 0;
              return (
                <Box key={item.id} borderBottom padding="400" display="flex" alignItems="center">
                  <img
                    src={item.image?.originalSrc || "https://cdn.shopify.com/s/files/1/0752/6435/6351/files/no-image-icon.png"}
                    width={60}
                    height={60}
                    style={{ borderRadius: 8, objectFit: "cover", border: "1px solid #eee" }}
                  />
                  <Box paddingInlineStart="400" flexGrow={1}>
                    <Text fontWeight="bold">{item.title}</Text>
                    <Text variant="bodySm">{item.sku}</Text>
                    <Text variant="bodySm">${item.discountedUnitPriceSet.shopMoney.amount} × {item.quantity}</Text>
                    <Text color="subdued" fontSize="12px">Refunded items will be removed from the order</Text>
                  </Box>
                  <Box>
                    <input
                      type="number"
                      min="0"
                      max={item.quantity}
                      value={selectedQty}
                      onChange={(e) => {
                        const qty = parseInt(e.target.value) || 0;
                        setSelectedProducts(prev => {
                          const rest = prev.filter(p => p.id !== item.id);
                          return qty > 0 ? [...rest, { id: item.id, title: item.title, quantity: qty, price: item.discountedUnitPriceSet.shopMoney.amount }] : rest;
                        });
                      }}
                      style={{
                        width: "60px",
                        height: "36px",
                        borderRadius: "8px",
                        border: "1px solid #d9d9d9",
                        textAlign: "center",
                        fontSize: "14px"
                      }}
                    />
                    <div style={{ fontSize: "14px", textAlign: "center", marginTop: 4 }}> / {item.quantity}</div>
                  </Box>
                </Box>
              );
            })}
          </Card>

          {/* Refund Shipping */}
          <Card>
            <Box padding="400" display="flex" alignItems="center" gap="300">
              <input
                type="checkbox"
                checked={shippingRefundSelected}
                onChange={e => setShippingRefundSelected(e.target.checked)}
                style={{ width: 18, height: 18 }}
              />
              <Text>Freight · ${shippingRefundAmount}</Text>
              <input
                type="text"
                disabled={!shippingRefundSelected}
                value={shippingRefundAmount}
                onChange={e => setShippingRefundAmount(e.target.value)}
                style={{
                  marginLeft: "auto",
                  width: 100,
                  height: 36,
                  borderRadius: "8px",
                  border: "1px solid #d9d9d9",
                  padding: "0 10px",
                  textAlign: "right",
                  fontSize: "14px"
                }}
              />
            </Box>
          </Card>

          {/* Summary */}
          <Box display="flex" justifyContent="flex-end" marginTop="600">
            <Card padding="400" style={{ width: 380 }}>
              <Text variant="headingMd" fontWeight="bold" marginBottom="300">Summary</Text>
              <Text color="subdued" marginBottom="300">No items selected.</Text>

              <Box display="flex" justifyContent="space-between" marginBottom="200">
                <Text>Refund amount</Text>
                <Text>Unknown gateway</Text>
              </Box>

              <input
                type="text"
                value={`$${refundTotal.toFixed(2)}`}
                readOnly
                style={{
                  width: "100%",
                  height: 40,
                  border: "1px solid #ccc",
                  borderRadius: 8,
                  paddingLeft: 10,
                  fontSize: "14px",
                  marginBottom: "8px"
                }}
              />
              <Text color="subdued" marginBottom="300">${availableToRefund} available for refund</Text>

              <Box display="flex" alignItems="center" marginBottom="300">
                <input type="checkbox" defaultChecked style={{ marginRight: 8 }} />
                <Text>Send <a href="#" style={{ color: "#1a73e8" }}>notification</a> once refund is finalized</Text>
              </Box>

              <Button fullWidth disabled variant="primary">
                Refund ${refundTotal.toFixed(2)}
              </Button>
            </Card>
          </Box>
        </>
      ) : (
        <Card sectioned>
          <Text>Loading...</Text>
        </Card>
      )}
    </div>
  </Page>
);
}
