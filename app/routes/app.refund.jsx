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

     while (hasNextPage && allOrders.length < 100) {
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
               if (node?.sourceName !== "web") {
                    const orderIdNum = node?.id.split("/").pop();
                    let transactionId = null, gateway = "manual", locationId = 70116966605;

                    try {
                         const txResp = await admin.rest?.get({ path: `/admin/api/2023-10/orders/${orderIdNum}/transactions.json` });
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
    return {
      ...item,
      quantity: remainingQty,
      originalQuantityRefunded: refundedQty, // ✅ store for tax fix
    };
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
const prevOrderIdRef = useRef(null);

useEffect(() => {
  if (selectedOrder?.id !== prevOrderIdRef.current) {
    prevOrderIdRef.current = selectedOrder?.id;
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

  // ✅ Parse total tax on the order
const fullOrderTax = parseFloat(selectedOrder?.totalTaxSet?.shopMoney?.amount || "0");

// ✅ New: refunded shipping amount (user input)
const refundedShippingAmount = shippingRefundSelected
  ? parseFloat(shippingRefundAmount || "0")
  : 0;

// ✅ New: full original shipping & shipping tax
const fullShippingAmount = parseFloat(
  selectedOrder?.shippingLines?.edges?.[0]?.node?.originalPriceSet?.shopMoney?.amount || "0"
);
const fullShippingTax = parseFloat(
  selectedOrder?.shippingLines?.edges?.[0]?.node?.taxLines?.[0]?.price || "0"
);

// ✅ Correct shipping tax calculation (only for refunded portion)
const shippingTax = shippingRefundSelected && fullShippingAmount > 0
  ? (fullShippingTax * (refundedShippingAmount / fullShippingAmount))
  : 0;

// ✅ Full product subtotal from the order
const fullSubtotal = selectedOrder?.lineItems?.reduce(
  (sum, item) =>
    sum + parseFloat(item.discountedUnitPriceSet?.shopMoney?.amount || "0") * item.quantity,
  0
);

// ✅ Selected product subtotal for refund
const productSubtotal = selectedProducts.reduce(
  (sum, item) => sum + (parseFloat(item.price) * item.quantity), 0
);

// ✅ Calculate proportional product tax only
const productTax = selectedProducts.reduce((totalTax, selected) => {
  const originalItem = selectedOrder?.lineItems?.find(item => item.id === selected.id);
  if (!originalItem || !originalItem.taxLines?.length) return totalTax;

  const totalItemTax = originalItem.taxLines.reduce(
    (sum, tax) => sum + parseFloat(tax.price || 0), 0
  );

  const totalQty = originalItem.quantity + (originalItem.originalQuantityRefunded || 0);
  const unitTax = totalQty > 0 ? totalItemTax / totalQty : 0;
  return totalTax + unitTax * selected.quantity;
}, 0);



// ✅ Final tax and total refund calculation
const taxAmount = productTax + shippingTax;
const refundTotal = productSubtotal + taxAmount + refundedShippingAmount;



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
          <Page>
               {/* <div style={{ padding: 20 }}> */}
               {selectedOrder ? (
                    <>
                         <Box paddingBlockEnd="300" display="flex" flexDirection="column" gap="200">
                              <Box display="flex" alignItems="center" gap="400">
                                   {selectedOrder?.displayFinancialStatus && (
                                        <Text variant="headingLg">
                                             <b>  #{selectedOrder?.name?.replace("#", "")} • Refund {' '}</b>
                                             <Text as="span" variant="bodySm">{' '} {' '}
                                                  {selectedOrder.displayFinancialStatus}
                                             </Text>
                                        </Text>
                                   )}
                              </Box>

                              <Box paddingBlock={200}>
                                   <Button plain onClick={goBack}>
                                        &larr; Back to Order List
                                   </Button>
                              </Box>
                         </Box>
                         <Layout>
                              <Layout.Section sectioned>
                                   <BlockStack gap={200}>
                                        <Card>
                                             <Text variant="headingMd">Order Line Items</Text>
                                             {selectedOrder.lineItems.map(item => {
                                                  const existing = selectedProducts.find(p => p.id === item.id);
                                                  const selectedQuantity = existing?.quantity || 0;
                                                  return (
                                                       <Box key={item.id} paddingBlock={300}>

                                                            <InlineGrid columns={['oneHalf', 'twoThirds', 'oneHalf', 'oneHalf', 'oneHalf']} gap={100}>

                                                                 <Thumbnail
                                                                      source={item?.image?.originalSrc || "https://cdn.shopify.com/s/files/1/0752/6435/6351/files/no-image-icon.png"}
                                                                      alt={item?.image?.altText || "Product image"}
                                                                      size="small"
                                                                 />
                                                                 <Text fontWeight="bold">{item.title}</Text>

                                                                 <Text variant="bodySm">{item.sku}</Text>
                                                                 <Text variant="bodySm">
                                                                      ${item.discountedUnitPriceSet.shopMoney.amount} × {item.quantity}
                                                                 </Text>

                                      <div style={{ display: "flex", flexDirection: "column" }}>
  <input
    type="number"
    min="0"
    max={item.quantity}
    value={selectedQuantity}
    onChange={(e) => {
      const qty = parseInt(e.target.value) || 0;
      if (qty > item.quantity) {
        alert(`❌ You cannot refund more than ${item.quantity} item(s).`);
        return;
      }
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
                                             {parseFloat(shippingRefundAmount) > 0 ? (
                                             <InlineGrid columns={['twoThirds', 'oneHalf']} >

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
                                                            onChange={e => setShippingRefundAmount(e.target.value)}
                                                            // style={{ marginLeft: "auto", width: 100, padding: 5 }}
                                                            style={{ width: "80px", height: '35px', border: '1px solid', borderRadius: '10px', paddingInline: '15px' }}

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


                                        <Card title="Reason for Refund" sectioned>
                                             <TextField
                                                  value={reasonForRefund}
                                                  onChange={setReasonForRefund}
                                                  multiline={2}
                                                  placeholder="Only you and staff can see this reason"
                                             />
                                        </Card>

                                        {/* ✅ Refund History Section */}
                                        <Card title="Refunded Items" sectioned>
                                             {loadingHistory ? (
                                                  <Box paddingBlockStart="200">
                                                       <Text>Loading refund history...</Text>
                                                  </Box>
                                             ) : refundHistory && refundHistory.length > 0 ? (
                                                  refundHistory.map((refund, refundIndex) => (
                                             <div
                                             key={refundIndex}
                                             >
                                                  {refund.refund_line_items.map((item, itemIndex) => {
                                                    const line = item.line_item;
                                                                 const imageUrl = `https://cdn.shopify.com/s/files/1/0752/6435/6351/files/no-image-icon.png`;
                                                                 return ( 
                                                  <Box
                                                       key={itemIndex} 
                                                       paddingBlock="200" display="flex" gap="300" paddingBlockEnd={300}>
                                                     <img src={imageUrl} alt={line?.title} width={60} height={60} style={{ borderRadius: 4, objectFit: 'cover' }} />
                                                       <Box paddingBlockEnd={300}>
                                                            <Text fontWeight="bold">{
                                                                 line?.title || 
                                                                 "Untitled Product"}</Text>
                                                            <Text>SKU: {
                                                                 line?.sku ||
                                                                 "N/A"}</Text>
                                                            <Text>Quantity Refunded: 
                                                                 {item.quantity} 
                                                            </Text>
                                                            <Text>Amount Refunded: 
                                                                 ${parseFloat(item.subtotal || 0).toFixed(2)}
                                                            </Text>
                                                            <Text>Tax: 
                                                                 ${parseFloat(item.total_tax || 0).toFixed(2)}
                                                            </Text>
                                                       </Box>
                                                       <Divider borderColor="border" />
                                                  </Box>
                                                  );
                                                            })} 
                                                  <Box paddingBlock="200" paddingBlockEnd={300}>

                                                       <Text fontWeight="bold">Refund Date:</Text>
                                                       <Text>
                                                            {new Date(refund.created_at).toLocaleString()}
                                                       </Text>
                                                       {refund.note && (
                                                       <Box paddingBlockStart="100" paddingBlockEnd={300}>
                                                            <BlockStack gap={2009}>
                                                                 <Text fontWeight="bold">Note:</Text>
                                                                 <Text> {refund.note} </Text>                                                                      
                                                            </BlockStack>
                                                       </Box>
                                                       )} 
                                                       <Divider borderColor="border" />
                                                       {refund.transactions?.[0]?.id && (
                                                       <Box paddingBlockStart="100" paddingBlockEnd={300} >
                                                            <Text fontWeight="bold">Transaction ID:</Text>
                                                            <Text> 
                                                                 {refund.transactions[0].id}
                                                            </Text>
                                                            <Text>Gateway: 
                                                                 {refund.transactions[0].gateway}
                                                            </Text>
                                                       </Box>
                                                       )}
                                                       <Divider borderColor="border" />
                                                  </Box>
                                                  
                                                  {refund.refund_shipping_lines?.length > 0 && (
                                                  <Box paddingBlock="200" paddingBlockEnd={300}>
                                                       <Text fontWeight="bold">Shipping Refunded</Text>
                                                       <Text>
                                                            Amount:
                                                            ${refund.refund_shipping_lines[0].subtotal_amount_set.shop_money.amount}
                                                       </Text>
                                                       <Text>
                                                            Tax: 
                                                            ${refund.order_adjustments?.[0]?.tax_amount_set?.shop_money?.amount || "0.00"}
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
                                                       <Text>${refundedShippingAmount.toFixed(2)}
</Text>
                                                  </Box>
                                                  <Box display="flex" justifyContent="space-between" paddingBlockStart="300">
                                                       <Text fontWeight="bold">Refund total</Text>
                                                       <Text fontWeight="bold">${refundTotal.toFixed(2)}</Text>
                                                  </Box>
                                                  <Box paddingBlockStart="200">
                                                       <Button fullWidth variant="secondary" onClick={handleCalculateRefund} disabled={selectedProducts.length === 0}>
                                                            Calculate Refund
                                                       </Button>
                                                  </Box>
                                                  <Box paddingBlockStart="300">
                                                       <Button fullWidth variant="primary" onClick={handleRefund} disabled={!refundMeta || selectedProducts.length === 0}>
                                                            {refundMeta
                                                                 ? `Refund $${refundMeta.amount} (TX: ${refundMeta.transaction_id})`
                                                                 : `Refund $${refundTotal.toFixed(2)}`}
                                                       </Button>
                                                  </Box>
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
                                        { title: "Order" },
                                        { title: "Order ID" },
                                        { title: "Customer" }, //  Added
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
                                             <IndexTable.Cell>{order.customerName || "N/A"}</IndexTable.Cell>
                                             <IndexTable.Cell>{order.customerEmail}</IndexTable.Cell>
                                             <IndexTable.Cell>{formatDate(order.createdAt)}</IndexTable.Cell>
                                             <IndexTable.Cell>
                                                  {order.totalPriceSet.shopMoney.amount} {order.totalPriceSet.shopMoney.currencyCode}
                                             </IndexTable.Cell>
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
               {/* </div>  */}
          </Page>
     );
}
