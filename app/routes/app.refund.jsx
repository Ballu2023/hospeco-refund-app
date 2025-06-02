// ✅ app/routes/app.refund.jsx — LOADER and ACTION
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useDebounce } from 'use-debounce';
import { ArrowLeftIcon } from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.toLowerCase().trim() || "";
  const page = parseInt(url.searchParams.get("page")) || 1;
  const selectedOrderId = url.searchParams.get("orderId") || null;

  const PAGE_SIZE = 10;
  let afterCursor = null;

  if (page > 1) {
    const skipCount = (page - 1) * PAGE_SIZE;
    const cursorQuery = `
      query GetCursors {
        orders(first: ${skipCount}, reverse: true) {
          edges { cursor }
        }
      }
    `;
    const cursorResponse = await admin.graphql(cursorQuery);
    const cursorData = await cursorResponse.json();
    const edges = cursorData?.data?.orders?.edges || [];
    afterCursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
  }

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
            customer { firstName lastName email }
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
              edges { node { key value } }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { first: PAGE_SIZE, after: afterCursor } });
  const data = await response.json();

  if (!data?.data) {
    console.error("❌ GraphQL Error:", JSON.stringify(data, null, 2));
    throw new Error("Failed to fetch orders");
  }

  const orders = await Promise.all(
    data.data.orders.edges
      .filter(({ node }) => node?.sourceName !== "web")
      .map(async ({ node, cursor }) => {
        const orderIdNum = node.id.split("/").pop();
        let transactionId = null;
        let gateway = "manual";
        let locationId = 70116966605;

        try {
          const txResp = await admin.rest?.get({
            path: `/admin/api/2023-10/orders/${orderIdNum}/transactions.json`,
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

        let lineItems = (node.lineItems?.edges || []).map(({ node }) => node) || [];

        let totalRefunded = 0;
        try {
          const refundRes = await fetch(`https://phpstack-1419716-5486887.cloudwaysapps.com/refunds/${orderIdNum}`);
          const refundJson = await refundRes.json();
          refundJson?.refunds?.forEach(refund => {
            totalRefunded += parseFloat(refund?.transactions?.[0]?.amount || 0);
          });

          const refundedMap = {};
          refundJson?.refunds?.forEach(refund => {
            refund?.refund_line_items?.forEach(refItem => {
              const plainId = refItem?.line_item_id?.toString();
              if (plainId) {
                refundedMap[plainId] = (refundedMap[plainId] || 0) + (refItem?.quantity || 0);
              }
            });
          });

          lineItems = lineItems
            .map(item => {
              const itemIdPlain = item.id.split("/").pop();
              const refundedQty = refundedMap[itemIdPlain] || 0;
              const remainingQty = (item?.quantity || 0) - refundedQty;
              if (remainingQty <= 0) return null;
              return { ...item, quantity: remainingQty, originalQuantityRefunded: refundedQty };
            })
            .filter(Boolean);
        } catch (err) {
          console.error("❌ Failed to fetch refund data:", err);
        }

        const customerName = `${node?.customer?.firstName || ""} ${node?.customer?.lastName || ""}`.trim();
        const customerEmail = node?.customer?.email || node?.email || "";

        const orderAmount = parseFloat(node?.totalPriceSet?.shopMoney?.amount || 0);
        const remainingAmount = Math.max(orderAmount - totalRefunded, 0).toFixed(2);

        return {
          ...node,
          cursor,
          lineItems: lineItems || [],
          orderId: orderIdNum,
          transactionId,
          gateway,
          locationId,
          metafields: Object.fromEntries(node?.metafields?.edges?.map(({ node }) => [node?.key, node?.value]) || []),
          customerName: customerName || "N/A",
          customerEmail: customerEmail || "N/A",
          totalRefunded: totalRefunded.toFixed(2),
          remainingAmount
        };
      })
  );

  const filteredOrders = search
    ? orders.filter(order =>
        (order?.name || "").toLowerCase().replace("#", "").includes(search.replace("#", "")) ||
        (order?.customerEmail || "").toLowerCase().includes(search)
      )
    : orders;

  const selectedOrder = selectedOrderId ? orders.find(o => o?.id === selectedOrderId) : null;

  return json({
    orders: filteredOrders || [],
    total: data?.data?.orders?.pageInfo?.hasNextPage ? page * PAGE_SIZE + 1 : page * PAGE_SIZE,
    page: page || 1,
    selectedOrder,
  });
};

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();
    const body = JSON.parse(formData.get("body") || "{}");
    const isCalculation = body?.mode === "calculate";
    const input = body?.variables?.input;
    const orderId = input?.orderId?.split("/").pop();

    if (!orderId) {
      throw new Error("Invalid order ID");
    }

    const payload = {
      refund: {
        refund_line_items: (input?.refundLineItems || []).map(item => ({
          line_item_id: item?.lineItemId?.split("/").pop() || "",
          quantity: item?.quantity || 0,
        })),
        shipping: input?.shipping ? { amount: input?.shipping?.amount || "0" } : undefined,
        currency: "AUD",
        notify: input?.notifyCustomer || false,
        note: input?.note || "Refund via app",
        transactions: isCalculation ? undefined : [{
          parent_id: input?.transactionId || "",
          amount: input?.totalAmount || "0",
          kind: "refund",
          gateway: input?.gateway || "manual",
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
    if (!res.ok) throw new Error(result?.error || "Failed to process refund");
    return json(result);
  } catch (err) {
    console.error("❌ Refund Error:", err);
    return json({ error: "Refund failed: " + (err?.message || "Unknown error") }, { status: 500 });
  }
};

// ✅ app/routes/app.refund.jsx — Full Remix UI Code (Polaris + Refund Logic)

import {
  Page, Layout, Card, Text, Box, Button, TextField,
  IndexTable, Pagination, Thumbnail, Grid,
  InlineGrid,
  Badge,
  BlockStack,
  Divider,
  Banner,
  InlineStack
} from "@shopify/polaris";
import { useLoaderData, useSearchParams, useFetcher } from "@remix-run/react";
import { useState, useEffect, useRef } from "react";

export default function RefundPage() {
  const { orders, total, page, selectedOrder: initialSelectedOrder } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [shippingRefundSelected, setShippingRefundSelected] = useState(false);
  const [shippingRefundAmount, setShippingRefundAmount] = useState("0.00");
  const [reasonForRefund, setReasonForRefund] = useState("");
  const [emailCustomer, setEmailCustomer] = useState(true);
  const [refundMeta, setRefundMeta] = useState(null);
  const [filter, setFilter] = useState("");
  const [debouncedFilter] = useDebounce(filter, 300);
  const [refundHistory, setRefundHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const fetcher = useFetcher();
  const prevOrderIdRef = useRef(null);
  const [shippingAmountManuallyChanged, setShippingAmountManuallyChanged] = useState(false);
  const [isRefunding, setIsRefunding] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);

  const data = {
    orders: Array.isArray(fetcher?.data?.orders) ? fetcher.data.orders : (Array.isArray(orders) ? orders : []),
    total: fetcher?.data?.total || total || 0,
    page: fetcher?.data?.page || page || 1,
    selectedOrder: initialSelectedOrder,
  };

  const selectedOrder = (isCalculating || isRefunding) ? initialSelectedOrder : (searchParams.get("orderId") ? initialSelectedOrder : null);

  useEffect(() => {
    console.log("Selected Order:", selectedOrder);
    console.log("Orders:", data?.orders);
    console.log("Refund History:", refundHistory);
    if (!Array.isArray(data?.orders)) {
      console.error("❌ data.orders is not an array:", data?.orders);
    }
  }, [selectedOrder, data?.orders, refundHistory]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    params.set("search", debouncedFilter);
    params.set("page", 1);
    fetcher.load(`/app/refund?${params.toString()}`);
  }, [debouncedFilter]);

  useEffect(() => {
    if (!selectedOrder) return;
    if (selectedOrder?.id !== prevOrderIdRef.current) {
      prevOrderIdRef.current = selectedOrder?.id;
      setSelectedProducts([]);
      setShippingRefundSelected(false);
      setShippingRefundAmount(calculateMaxShippingRefund(selectedOrder, refundHistory));
      setReasonForRefund("");
      setEmailCustomer(true);
      setRefundMeta(null);
      setShippingAmountManuallyChanged(false);
    }
  }, [selectedOrder, refundHistory]);

  useEffect(() => {
    if (fetcher?.data?.transactionId && fetcher?.data?.amount) {
      setRefundMeta({
        transaction_id: fetcher.data.transactionId,
        amount: fetcher.data.amount
      });
    }
  }, [fetcher?.data]);

  useEffect(() => {
    const fetchRefundHistory = async () => {
      if (!selectedOrder) return;
      setLoadingHistory(true);
      try {
        const orderIdNum = selectedOrder?.id?.split("/").pop();
        if (!orderIdNum) throw new Error("Invalid order ID");
        const res = await fetch(`https://phpstack-1419716-5486887.cloudwaysapps.com/refunds/${orderIdNum}`);
        const data = await res.json();
        if (!Array.isArray(data?.refunds)) {
          console.error("❌ Refund history is not an array:", data?.refunds);
          setRefundHistory([]);
        } else {
          setRefundHistory(data.refunds);
        }
      } catch (err) {
        console.error("❌ Error fetching refund history:", err);
        setRefundHistory([]);
      } finally {
        setLoadingHistory(false);
      }
    };
    fetchRefundHistory();
  }, [selectedOrder]);

  useEffect(() => {
    if (!selectedOrder || !refundHistory || shippingAmountManuallyChanged) return;
    const remainingShipping = calculateMaxShippingRefund(selectedOrder, refundHistory);
    setShippingRefundAmount(remainingShipping);
  }, [refundHistory, selectedOrder, shippingAmountManuallyChanged]);

  useEffect(() => {
    setRefundMeta(null);
  }, [selectedProducts, shippingRefundAmount]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    fetcher.load(`/app/refund?${params.toString()}`);
  }, [searchParams]);

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

  const fullOrderTax = parseFloat(selectedOrder?.totalTaxSet?.shopMoney?.amount || "0");

  const refundedShippingAmount = shippingRefundSelected
    ? parseFloat(shippingRefundAmount || "0")
    : 0;

  const fullShippingAmount = parseFloat(
    selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0"
  );
  const fullShippingTax = parseFloat(
    selectedOrder?.shippingLines?.edges?.[0]?.node?.taxLines?.[0]?.price || "0"
  );

  const shippingTax = shippingRefundSelected && fullShippingAmount > 0
    ? (fullShippingTax * (refundedShippingAmount / fullShippingAmount))
    : 0;

  const fullSubtotal = (selectedOrder?.lineItems || []).reduce(
    (sum, item) =>
      sum + parseFloat(item?.discountedUnitPriceSet?.shopMoney?.amount || "0") * (item?.quantity || 0),
    0
  );

  const productSubtotal = selectedProducts.reduce(
    (sum, item) => sum + (parseFloat(item?.price || "0") * (item?.quantity || 0)),
    0
  );

  const productTax = (selectedProducts?.length ? selectedProducts : []).reduce((totalTax, selected) => {
    if (!selectedOrder || !Array.isArray(selectedOrder?.lineItems)) return totalTax;
    const originalItem = (selectedOrder.lineItems || []).find(item => item?.id === selected?.id);
    if (!originalItem || !Array.isArray(originalItem?.taxLines)) return totalTax;
    const totalItemTax = originalItem.taxLines.reduce(
      (sum, tax) => sum + parseFloat(tax?.price || 0),
      0
    );
    const totalQty = (originalItem?.quantity || 0) + (originalItem?.originalQuantityRefunded || 0);
    const unitTax = totalQty > 0 ? totalItemTax / totalQty : 0;
    return totalTax + unitTax * (selected?.quantity || 0);
  }, 0);

  const taxAmount = productTax + shippingTax;
  const refundTotal = productSubtotal + taxAmount + refundedShippingAmount;

  const preparePayload = () => ({
    mode: refundMeta ? "refund" : "calculate",
    variables: {
      input: {
        orderId: selectedOrder?.id || "",
        refundLineItems: selectedProducts.map(item => ({
          lineItemId: item?.id || "",
          quantity: item?.quantity || 0,
          price: item?.price || "0",
          title: item?.title || ""
        })),
        shipping: shippingRefundSelected ? { amount: shippingRefundAmount } : undefined,
        notifyCustomer: emailCustomer,
        note: reasonForRefund || "Refund processed via app",
        totalAmount: refundMeta?.amount || refundTotal,
        transactionId: refundMeta?.transaction_id || selectedOrder?.transactionId || "",
        gateway: selectedOrder?.gateway || "manual",
        locationId: selectedOrder?.locationId || "70116966605"
      }
    }
  });

  const handleCalculateRefund = () => {
    if (selectedProducts.length === 0) return;
    setIsCalculating(true);
    const formData = new FormData();
    formData.append("body", JSON.stringify({ ...preparePayload(), mode: "calculate" }));
    fetcher.submit(formData, { method: "POST" });
    setIsCalculating(false);
  };

  const handleRefund = async () => {
    if (selectedProducts.length === 0 || !refundMeta) return;
    setIsRefunding(true);
    const metafields = selectedOrder?.metafields || {};
    const summary = `\n🧾 Refund Summary:\n\n` +
      selectedProducts.map(p => `• ${p?.title || "Unknown"} (Qty: ${p?.quantity || 0} × $${p?.price || "0"})`).join("\n") +
      (shippingRefundSelected ? `\n• Shipping: $${parseFloat(shippingRefundAmount || "0").toFixed(2)}` : "") +
      `\n• Tax: $${taxAmount.toFixed(2)}` +
      `\n• Total Refund: $${refundMeta?.amount || "0"}` +
      `\n\n📌 Payment Info:\n` +
      `• Mode: ${metafields?.payment_mode || "N/A"}\n` +
      `• Txn ID: ${metafields?.transaction_id_number || "N/A"}` +
      `\n\nClick OK to continue with the refund.`;
    if (!window.confirm(summary)) {
      setIsRefunding(false);
      return;
    }

    const paymentMode = metafields?.payment_mode?.toLowerCase();
    const transactionId = metafields?.transaction_id_number;
    const amount = refundMeta?.amount;

    try {
      if (paymentMode === 'paypal') {
        const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/paypal-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, amount }),
        });

        const data = await res.json();
        if (!data?.success) {
          alert("❌ PayPal refund failed: " + (data?.message || "Unknown error"));
          setIsRefunding(false);
          return;
        }

        const payload = preparePayload();
        payload.variables.input.note = `Refunded via PayPal: ${data?.paypalRefundId || "N/A"} at 11:47 AM IST on 02/06/2025`;
        const formData = new FormData();
        formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
        fetcher.submit(formData, { method: "POST" });

      } else if (paymentMode === 'stripe') {
        const res = await fetch("https://phpstack-1419716-5486887.cloudwaysapps.com/stripe-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chargeId: transactionId, amount })
        });

        const data = await res.json();
        if (!data?.success) {
          alert("❌ Stripe refund failed: " + (data?.message || "Unknown error"));
          setIsRefunding(false);
          return;
        }

        const payload = preparePayload();
        payload.variables.input.note = `Refunded via Stripe: ${data?.stripeRefundId || "N/A"} at 11:47 AM IST on 02/06/2025`;
        const formData = new FormData();
        formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
        fetcher.submit(formData, { method: "POST" });

      } else {
        const payload = preparePayload();
        payload.variables.input.note = `Refund processed via app at 11:47 AM IST on 02/06/2025`;
        const formData = new FormData();
        formData.append("body", JSON.stringify({ ...payload, mode: "refund" }));
        fetcher.submit(formData, { method: "POST" });
      }

      alert(`\n✅ Refund Successful!\n\nAmount: $${amount || "0"}\nTxn: ${refundMeta?.transaction_id || "N/A"}`);
      setShippingAmountManuallyChanged(false);
      goBack();

    } catch (err) {
      alert("❌ Refund error: " + (err?.message || "Unknown error"));
      setIsRefunding(false);
    }
  };

  function calculateMaxShippingRefund(selectedOrder, refundHistory) {
    const originalShipping = parseFloat(
      selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0"
    );

    let totalShippingRefunded = 0;
    const safeRefundHistory = Array.isArray(refundHistory) ? refundHistory : [];
    safeRefundHistory.forEach(refund => {
      const shippingLines = Array.isArray(refund?.refund_shipping_lines) ? refund.refund_shipping_lines : [];
      shippingLines.forEach(ship => {
        totalShippingRefunded += parseFloat(ship?.subtotal_amount_set?.shop_money?.amount || 0);
      });
    });

    return Math.max(originalShipping - totalShippingRefunded, 0).toFixed(2);
  }

  function formatDate(dateStr) {
    if (!dateStr) return "N/A";
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "Invalid Date";
    const d = String(date.getDate()).padStart(2, "0");
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const y = date.getFullYear();
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `${d}/${m}/${y} ${h}:${min}:${s}`;
  }

  return (
    <Page>
      {selectedOrder && Array.isArray(selectedOrder?.lineItems) ? (
        <>
          <Box paddingBlockEnd="300">
            <Box>
              {selectedOrder?.displayFinancialStatus && (
                <Text variant="headingLg">
                  <InlineStack gap={300}>
                    <Text variant="headingLg">#{selectedOrder?.name?.replace("#", "") || "Unknown"} • Refund</Text>
                    <Box paddingBlockStart={'025'}>
                      <Text as="p" variant="bodyMd">
                        {selectedOrder?.displayFinancialStatus || "N/A"}
                      </Text>
                    </Box>
                  </InlineStack>
                </Text>
              )}
            </Box>
            <Box paddingBlock={200}>
              <Button plain onClick={goBack} icon={ArrowLeftIcon}>
                Back to Order List
              </Button>
            </Box>
          </Box>
          <Layout>
            <Layout.Section sectioned>
              <BlockStack gap={200}>
                <Card>
                  <Text variant="headingMd">Order Line Items</Text>
                  {(selectedOrder?.lineItems || []).map(item => {
                    const existing = selectedProducts.find(p => p?.id === item?.id);
                    const selectedQuantity = existing?.quantity || 0;
                    return (
                      <Box key={item?.id || Math.random()} paddingBlock={300}>
                        <InlineGrid columns={['oneHalf', 'twoThirds', 'oneHalf', 'oneHalf', 'oneHalf']} gap={100}>
                          <Thumbnail
                            source={item?.image?.originalSrc || "https://cdn.shopify.com/s/files/1/0752/6435/6351/files/no-image-icon.png"}
                            alt={item?.image?.altText || "Product image"}
                            size="small"
                          />
                          <Text fontWeight="bold">{item?.title || "N/A"}</Text>
                          <Text variant="bodySm">{item?.sku || "N/A"}</Text>
                          <Text variant="bodySm">
                            ${item?.discountedUnitPriceSet?.shopMoney?.amount || "0"} × {item?.quantity || 0}
                          </Text>
                          <div style={{ display: "flex", flexDirection: "column" }}>
                            <input
                              type="number"
                              min="0"
                              max={item?.quantity || 0}
                              value={selectedQuantity}
                              onChange={(e) => {
                                const qty = parseInt(e.target.value) || 0;
                                if (qty > (item?.quantity || 0)) {
                                  alert(`❌ You cannot refund more than ${item?.quantity || 0} item(s).`);
                                  return;
                                }
                                setSelectedProducts(prev => {
                                  const withoutThis = prev.filter(p => p?.id !== item?.id);
                                  if (qty > 0) {
                                    return [...withoutThis, {
                                      id: item?.id || "",
                                      title: item?.title || "",
                                      quantity: qty,
                                      price: item?.discountedUnitPriceSet?.shopMoney?.amount || "0"
                                    }];
                                  } else {
                                    return withoutThis;
                                  }
                                });
                              }}
                              style={{
                                width: "80px",
                                border: '1px solid',
                                borderRadius: '10px',
                                paddingInline: '15px',
                                height: '35px'
                              }}
                            />
                          </div>
                        </InlineGrid>
                      </Box>
                    );
                  })}
                </Card>
                <Card title="Refund Shipping" sectioned>
                  <Text variant="headingMd">Refund Shipping</Text>
                  {parseFloat(shippingRefundAmount || "0") > 0 ? (
                    <InlineGrid columns={['twoThirds', 'oneHalf']}>
                      <InlineStack gap={300} blockAlign="center">
                        <input
                          type="checkbox"
                          checked={shippingRefundSelected}
                          onChange={e => setShippingRefundSelected(e.target.checked)}
                        />
                        <Text>Freight - Max Refundable: ${shippingRefundAmount}</Text>
                      </InlineStack>
                      <Text as="span" alignment="end">
                        <Box paddingInlineEnd={400}>
                          <input
                            type="text"
                            disabled={!shippingRefundSelected}
                            value={shippingRefundAmount}
                            onChange={(e) => {
                              const value = e.target.value;
                              const entered = parseFloat(value || "0");
                              const maxRefundable = parseFloat(calculateMaxShippingRefund(selectedOrder, refundHistory));
                              if (isNaN(entered) || entered === 0 || value === "") {
                                setShippingRefundAmount(maxRefundable.toFixed(2));
                                setShippingAmountManuallyChanged(false);
                                return;
                              }
                              if (entered > maxRefundable) {
                                alert(`❌ Maximum refundable shipping is $${maxRefundable.toFixed(2)}`);
                                setShippingRefundAmount(maxRefundable.toFixed(2));
                                setShippingAmountManuallyChanged(false);
                                return;
                              }
                              setShippingRefundAmount(entered.toFixed(2));
                              setShippingAmountManuallyChanged(true);
                            }}
                            style={{
                              width: "80px",
                              height: '35px',
                              border: '1px solid',
                              borderRadius: '10px',
                              paddingInline: '15px'
                            }}
                          />
                        </Box>
                      </Text>
                    </InlineGrid>
                  ) : (
                    <Banner>
                      <p>Shipping has already been fully refunded.</p>
                    </Banner>
                  )}
                </Card>
                <Card title="Reason for Refund">
                  <BlockStack gap={200}>
                    <Text as="h3" variant="headingMd">Reason for Refund</Text>
                    <TextField
                      value={reasonForRefund}
                      onChange={setReasonForRefund}
                      multiline={2}
                    />
                    <Text as="p" variant="bodyMd">Only you and staff can see this reason</Text>
                  </BlockStack>
                </Card>
                <Card title="Refunded Items" sectioned>
                  {loadingHistory ? (
                    <Box paddingBlockStart="200">
                      <Text>Loading refund history...</Text>
                    </Box>
                  ) : refundHistory?.length > 0 ? (
                    refundHistory.map((refund, refundIndex) => (
                      <div key={refundIndex}>
                        {(Array.isArray(refund?.refund_line_items) ? refund.refund_line_items : []).map((item, itemIndex) => {
                          const line = item?.line_item || {};
                          return (
                            <Box
                              key={itemIndex}
                              paddingBlock="200"
                              display="flex"
                              gap="300"
                              paddingBlockEnd={300}
                            >
                              <Box paddingBlockEnd={300}>
                                <Text fontWeight="bold">
                                  {line?.title || "Untitled Product"}
                                </Text>
                                <Text>SKU: {line?.sku || "N/A"}</Text>
                                <Text>Quantity Refunded: ${item?.quantity || 0}</Text>
                                <Text>Amount Refunded: ${parseFloat(item?.subtotal || 0).toFixed(2)}</Text>
                                <Text>Tax: ${parseFloat(item?.total_tax || 0).toFixed(2)}</Text>
                              </Box>
                              <Divider borderColor="border" />
                            </Box>
                          );
                        })}
                        <Box paddingBlock="200" paddingBlockEnd={300}>
                          <Text fontWeight="bold">Refund Date:</Text>
                          <Text>{new Date(refund?.created_at).toLocaleString()}</Text>
                          {refund?.note && (
                            <Box paddingBlockStart="100" paddingBlockEnd={300}>
                              <BlockStack gap={200}>
                                <Text fontWeight="bold">Note:</Text>
                                <Text>{refund.note}</Text>
                              </BlockStack>
                            </Box>
                          )}
                          <Divider borderColor="border" />
                          {refund?.transactions?.[0]?.id && (
                            <Box paddingBlockStart="100" paddingBlockEnd={300}>
                              <Text fontWeight="bold">Transaction ID:</Text>
                              <Text>{refund.transactions[0].id}</Text>
                              <Text>Gateway: {refund.transactions[0].gateway}</Text>
                            </Box>
                          )}
                          <Divider borderColor="border" />
                        </Box>
                        {(Array.isArray(refund?.refund_shipping_lines) && refund.refund_shipping_lines.length > 0) && (
                          <Box paddingBlock="200" paddingBlockEnd={300}>
                            <Text fontWeight="bold">Shipping Refunded</Text>
                            <Text>
                              Amount: ${refund?.refund_shipping_lines?.[0]?.subtotal_amount_set?.shop_money?.amount || "0"}
                            </Text>
                            <Text>
                              Tax: ${refund?.order_adjustments?.[0]?.tax_amount_set?.shop_money?.amount || "0.00"}
                            </Text>
                          </Box>
                        )}
                      </div>
                    ))
                  ) : (
                    <Text color="subdued">No refund history available.</Text>
                  )}
                </Card>
              </BlockStack>
            </Layout.Section>
            <Layout.Section variant="oneThird">
              <Box paddingStartBlock={400}>
                <Card title="Summary" sectioned>
                  <BlockStack gap={200}>
                    <Box display="flex" justifyContent="space-between">
                      <Text fontWeight="bold">Item subtotal</Text>
                      <Text>${productSubtotal.toFixed(2)}</Text>
                    </Box>
                    <Box display="flex" justifyContent="space-between" paddingBlockStart="100">
                      <Text fontWeight="bold">Tax</Text>
                      <Text>${taxAmount.toFixed(2)}</Text>
                    </Box>
                    <Box display="flex" justifyContent="space-between" paddingBlockStart="100">
                      <Text fontWeight="bold">Shipping</Text>
                      <Text>${refundedShippingAmount.toFixed(2)}</Text>
                    </Box>
                    <Box display="flex" justifyContent="space-between" paddingBlockStart="300">
                      <Text fontWeight="bold">Refund total</Text>
                      <Text fontWeight="bold">${refundTotal.toFixed(2)}</Text>
                    </Box>
                    {!refundMeta && (
                      <Box paddingBlockStart="200">
                        <Button
                          fullWidth
                          variant="secondary"
                          onClick={handleCalculateRefund}
                          disabled={selectedProducts.length === 0 || isCalculating}
                        >
                          Calculate Refund
                        </Button>
                      </Box>
                    )}
                    {refundMeta && (
                      <Box paddingBlockStart="300">
                        <Button
                          fullWidth
                          variant="primary"
                          onClick={handleRefund}
                          disabled={selectedProducts.length === 0 || isRefunding}
                        >
                          Refund ${refundMeta?.amount || "0"}
                        </Button>
                      </Box>
                    )}
                  </BlockStack>
                </Card>
              </Box>
            </Layout.Section>
          </Layout>
        </>
      ) : (
        <Layout.Section>
          <Card>
            <Box paddingBlockEnd="300">
              <TextField
                label="Search orders by number or email"
                value={filter}
                onChange={setFilter}
                autoComplete="off"
                placeholder="Search #5521, email etc"
              />
            </Box>
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={data?.orders?.length || 0}
              selectedItemsCount={0}
              headings={[
                { title: "Order" },
                { title: "Order ID" },
                { title: "Customer" },
                { title: "Email" },
                { title: "Date" },
                { title: "Total" },
                { title: "Payment Status" }
              ]}
            >
              {(data?.orders || []).map((order, index) => (
                <IndexTable.Row id={order?.id || index} key={order?.id || index} position={index}>
                  <IndexTable.Cell>
                    <Button variant="plain" onClick={() => showOrder(order?.id || "")}>
                      {order?.name || "N/A"}
                    </Button>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{order?.orderId || "N/A"}</IndexTable.Cell>
                  <IndexTable.Cell>{order?.customerName || "N/A"}</IndexTable.Cell>
                  <IndexTable.Cell>{order?.customerEmail || "N/A"}</IndexTable.Cell>
                  <IndexTable.Cell>{formatDate(order?.createdAt)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    ${order?.remainingAmount || "0"} {order?.totalPriceSet?.shopMoney?.currencyCode || "N/A"}
                  </IndexTable.Cell>
                  <IndexTable.Cell>{order?.displayFinancialStatus || "Unknown"}</IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
            <Box padding="300" display="flex" justifyContent="center">
              {(data?.orders?.length || 0) > 0 && (() => {
                const totalPages = Math.ceil((data?.total || 0) / 10);
                const currentPage = data?.page || 1;
                const windowSize = 3;
                let startPage = Math.max(currentPage - 1, 1);
                let endPage = Math.min(currentPage + 1, totalPages);

                if (currentPage === 1) endPage = Math.min(3, totalPages);
                if (currentPage === totalPages) startPage = Math.max(totalPages - 2, 1);

                const pageNumbers = [];
                for (let i = startPage; i <= endPage; i++) {
                  pageNumbers.push(i);
                }

                return (
                  <InlineStack gap="200">
                    {pageNumbers.map(pageIndex => (
                      <Button
                        key={pageIndex}
                        variant={pageIndex === currentPage ? "primary" : "secondary"}
                        onClick={() => updatePage(pageIndex)}
                      >
                        {pageIndex}
                      </Button>
                    ))}
                  </InlineStack>
                );
              })()}
            </Box>
          </Card>
        </Layout.Section>
      )}
    </Page>
  );
}