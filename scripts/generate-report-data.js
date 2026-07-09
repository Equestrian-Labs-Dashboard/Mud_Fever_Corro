// ============================================================
// Mud Fever Sales Report — GitHub Actions / Node.js Backend
// Generates data/report-data.json for a static GitHub Pages app.
//
// Required GitHub Actions Secrets:
//   SHOPIFY_STORE = your-store.myshopify.com
//   SHOPIFY_TOKEN = shpat_xxxxxxxxx
//
// Optional GitHub Actions Variables:
//   SHOPIFY_API_VERSION = 2024-01
//   MUD_FEVER_INITIAL_STOCK_RECEIVED
//   MUD_FEVER_STOCK_RECEIVED_DATE = YYYY-MM-DD
//   MUD_FEVER_SKU
//   MUD_FEVER_LOCATION_ID
//   MUD_FEVER_LOCATION_NAME
//   MUD_FEVER_WHOLESALE_PRICE
//   MUD_FEVER_DEDUCT_MARKETING_SHIPPING = true/false
// ============================================================

const fs = require('node:fs');
const path = require('node:path');

const STORE = cleanStore_(process.env.SHOPIFY_STORE || '');
const TOKEN = process.env.SHOPIFY_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';

const MUD_FEVER_KEYWORD = 'mud fever';
const MUD_FEVER_BRAND_NAME = 'Mud Fever';
const MUD_FEVER_INITIAL_STOCK_RECEIVED_RAW = process.env.MUD_FEVER_INITIAL_STOCK_RECEIVED || process.env.MUD_FEVER_STARTING_BALANCE || process.env.MUD_FEVER_INITIAL_INVENTORY || '';
const MUD_FEVER_INITIAL_STOCK_RECEIVED = MUD_FEVER_INITIAL_STOCK_RECEIVED_RAW === '' ? null : parseFloat(MUD_FEVER_INITIAL_STOCK_RECEIVED_RAW);
const MUD_FEVER_STOCK_RECEIVED_DATE = process.env.MUD_FEVER_STOCK_RECEIVED_DATE || '';
const MUD_FEVER_SKU = process.env.MUD_FEVER_SKU || '';
const MUD_FEVER_LOCATION_ID = process.env.MUD_FEVER_LOCATION_ID || '63267766330';
const MUD_FEVER_LOCATION_NAME = process.env.MUD_FEVER_LOCATION_NAME || 'New Wellington Warehouse';
const MUD_FEVER_WHOLESALE_PRICE = parseFloat(process.env.MUD_FEVER_WHOLESALE_PRICE || '0');
const MUD_FEVER_DEDUCT_MARKETING_SHIPPING = String(process.env.MUD_FEVER_DEDUCT_MARKETING_SHIPPING || 'true').toLowerCase() !== 'false';

const VALID_REPS = ['AW','AV','DG','JW','JS','LH','SS','CY','NP','DM'];
const MARKETING_TERMS = [
  'marketing', 'sponsorship', 'sponsored', 'seeded', 'seeding', 'product seeding',
  'gift', 'elite gift', 'giveaway', 'promo', 'promotion', 'influencer', 'ambassador',
  'review', 'sample', 'press', 'pr', 'social', 'content creator'
];
const INVENTORY_ITEMS_BATCH_SIZE = 50;
const FETCH_DELAY_MS = 650;

async function main() {
  validateConfig_();
  const periods = buildPeriods_();
  const reports = {};

  for (const period of [...periods.months, ...periods.quarters, ...periods.weeks]) {
    console.log(`Generating ${period.key} · ${period.label}`);
    reports[period.key] = await getMudFeverData(period.params);
    await sleep_(FETCH_DELAY_MS);
  }

  const defaultMonth = periods.months[1] || periods.months[0];
  const bundle = {
    ok: true,
    generated_at: new Date().toISOString(),
    default_key: defaultMonth ? defaultMonth.key : (periods.months[0] || periods.weeks[0]).key,
    report_name: 'Mud Fever Sales Report',
    brand_name: MUD_FEVER_BRAND_NAME,
    source_rule: 'Product title / line item title contains "Mud Fever"',
    periods,
    reports,
    config_public: {
      api_version: API_VERSION,
      keyword: MUD_FEVER_KEYWORD,
      brand_name: MUD_FEVER_BRAND_NAME,
      location_name: MUD_FEVER_LOCATION_NAME,
      location_id: MUD_FEVER_LOCATION_ID,
      cogs_source: 'Shopify Inventory Item cost via variant.inventory_item_id'
    }
  };

  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report-data.json'), JSON.stringify(bundle, null, 2));
  console.log('Wrote data/report-data.json');
}

async function getMudFeverData(params = {}) {
  const range = resolveDateRange_(params);
  const orders = await fetchAllActivityOrders_(range.startISO, range.endISO);
  if (orders.error) return { error: orders.error, period_label: range.periodLabel };

  const costPack = await prefetchMudFeverVariantCosts_(orders);
  const costByVariant = costPack.costByVariant || {};
  const warnings = costPack.warnings || [];

  const rows = [];
  const orderSeen = {};
  const repMap = {};
  const stats = {
    total_orders_scanned: orders.length,
    mud_fever_orders: 0,
    mud_fever_lines: 0,
    atletix_lines: 0,
    cogs_missing_lines: 0,
    cogs_missing_variant_count: costPack.missingVariantCount || 0,
    keyword: MUD_FEVER_KEYWORD
  };

  let grossSales = 0;
  let unitsInRange = 0;
  let netSales = 0;
  let totalDiscount = 0;
  let totalCogs = 0;
  let commercialUnitsSold = 0;
  let marketingUnitsSeeded = 0;
  let creditUnits = 0;
  let commercialGrossSales = 0;
  let commercialNetSales = 0;
  let commercialDiscount = 0;
  let commercialCogs = 0;
  let marketingGrossValue = 0;
  let marketingNetSales = 0;
  let marketingCogs = 0;
  let marketingShippingDeductions = 0;
  let creditsAdjustments = 0;
  const commercialOrderSeen = {};
  const marketingOrderSeen = {};

  for (const order of orders) {
    const customerTags = order.customer ? (order.customer.tags || '') : '';
    const orderTags = order.tags || '';
    const repInfo = extractRep_(customerTags, orderTags);
    const rep = repInfo.rep || 'UNASSIGNED';
    let customerName = order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'N/A';
    if (!customerName) customerName = 'N/A';
    const customerEmail = getCustomerEmail_(order);
    const orderRows = [];

    if (isDateInRange_(order.created_at, range.startISO, range.endISO)) {
      for (const item of (order.line_items || [])) {
        if (String(item.title || '').toLowerCase() === 'shipping') continue;
        if (!lineItemTitleHasMudFever_(item)) continue;

        const qty = parseInt(item.quantity || 0, 10);
        const gross = parseFloat(item.price || 0) * qty;
        const discounts = (item.discount_allocations || []).reduce((s, d) => s + parseFloat(d.amount || 0), 0);
        const net = round2_(gross - discounts);
        const variantId = item.variant_id ? String(item.variant_id) : '';
        const costInfo = variantId ? costByVariant[variantId] : null;
        const unitCogs = costInfo && costInfo.unit_cost !== null && costInfo.unit_cost !== undefined ? parseFloat(costInfo.unit_cost || 0) : 0;
        const cogs = round2_(unitCogs * Math.max(qty, 0));
        const cogsStatus = !variantId ? 'Missing variant_id' : (!costInfo ? 'COGS not found' : (costInfo.cost_missing ? 'COGS missing in Shopify' : 'OK'));
        if (cogsStatus !== 'OK') stats.cogs_missing_lines += 1;

        const marketingReason = getMarketingReason_(order, item);
        const isLikelyFree = gross > 0 && discounts >= gross * 0.95;
        let type = 'Commercial Sale';
        let reason = 'Paid Mud Fever sale';
        if (qty <= 0 || net < 0) {
          type = 'Credit/Return';
          reason = 'Negative quantity or net amount';
        } else if (marketingReason || net === 0 || isLikelyFree) {
          type = 'Marketing';
          reason = marketingReason || (isLikelyFree ? '100% discount/free unit' : 'Net sales is zero');
        }

        orderRows.push({
          order_id: order.name || order.id,
          order_numeric_id: order.id,
          order_date: order.created_at || '',
          customer: customerName,
          customer_email: customerEmail,
          rep,
          rep_source: repInfo.source || 'missing',
          product: item.title || '',
          line_name: item.name || '',
          variant: item.variant_title || '',
          sku: item.sku || '',
          variant_id: variantId,
          quantity: qty,
          gross: round2_(gross),
          discount: round2_(discounts),
          net,
          unit_cogs: round2_(unitCogs),
          cogs,
          cogs_status: cogsStatus,
          type,
          reason,
          order_tags: orderTags,
          customer_tags: customerTags,
          financial_status: order.financial_status || '',
          cancelled_at: order.cancelled_at || ''
        });
      }
    }

    appendMudFeverRefundRowsInRange_(order, range, costByVariant, {
      customerName,
      customerEmail,
      rep,
      repSource: repInfo.source || 'missing',
      orderTags,
      customerTags,
      orderRows,
      stats
    });

    if (!orderRows.length) continue;

    const orderShipping = getOrderShipping_(order);
    const totalMudFeverQtyInOrder = orderRows.reduce((sum, row) => sum + Math.max(row.quantity || 0, 0), 0);
    const marketingQtyInOrder = orderRows.reduce((sum, row) => sum + (row.type === 'Marketing' ? Math.max(row.quantity || 0, 0) : 0), 0);

    for (const row of orderRows) {
      row.order_shipping_total = round2_(orderShipping);
      row.marketing_shipping_deduction = (MUD_FEVER_DEDUCT_MARKETING_SHIPPING && row.type === 'Marketing' && totalMudFeverQtyInOrder > 0)
        ? round2_(orderShipping * (Math.max(row.quantity || 0, 0) / totalMudFeverQtyInOrder))
        : 0;
      row.activity_group = row.type === 'Marketing' ? 'Marketing Activities' : (row.type === 'Commercial Sale' ? 'Commercial Sales' : 'Credits / Returns');
      row.vendor_billing_status = row.type === 'Marketing' ? 'Marketing / Seeded' : (row.type === 'Commercial Sale' ? 'Regular Order' : 'Credit / Return');
    }

    stats.mud_fever_orders += 1;
    orderSeen[String(order.id)] = true;
    if (marketingQtyInOrder > 0) marketingOrderSeen[String(order.id)] = true;

    for (const row of orderRows) {
      stats.mud_fever_lines += 1;
      stats.atletix_lines = stats.mud_fever_lines;
      rows.push(row);
      grossSales += row.gross;
      unitsInRange += row.quantity;
      netSales += row.net;
      totalDiscount += row.discount;
      totalCogs += row.cogs;

      if (row.type === 'Commercial Sale') {
        commercialUnitsSold += Math.max(row.quantity || 0, 0);
        commercialGrossSales += row.gross;
        commercialNetSales += row.net;
        commercialDiscount += row.discount;
        commercialCogs += row.cogs;
        commercialOrderSeen[String(row.order_numeric_id)] = true;
      } else if (row.type === 'Marketing') {
        marketingUnitsSeeded += Math.max(row.quantity || 0, 0);
        marketingGrossValue += row.gross;
        marketingNetSales += row.net;
        marketingCogs += row.cogs;
        marketingShippingDeductions += row.marketing_shipping_deduction || 0;
      } else {
        commercialUnitsSold += Math.min(row.quantity || 0, 0);
        commercialNetSales += row.net;
        commercialCogs += row.cogs;
        creditUnits += Math.abs(row.quantity || 0);
        if (row.net < 0) creditsAdjustments += Math.abs(row.net || 0);
      }

      if (!repMap[row.rep]) {
        repMap[row.rep] = { rep: row.rep, rep_source: row.rep_source, units: 0, gross_sales: 0, net_sales: 0, discount: 0, cogs: 0, lines_count: 0, orders: {} };
      }
      repMap[row.rep].units += row.quantity;
      repMap[row.rep].gross_sales += row.gross;
      repMap[row.rep].net_sales += row.net;
      repMap[row.rep].discount += row.discount;
      repMap[row.rep].cogs += row.cogs;
      repMap[row.rep].lines_count += 1;
      repMap[row.rep].orders[String(row.order_numeric_id)] = true;
    }
  }

  rows.sort(sortByDateDesc_);
  const inventoryStatus = await buildMudFeverInventoryStatus_(range, {
    period_commercial_units: commercialUnitsSold,
    period_marketing_units: marketingUnitsSeeded,
    period_total_units: unitsInRange
  });
  if (inventoryStatus && inventoryStatus.warning) warnings.push(inventoryStatus.warning);
  stats.atletix_lines = stats.mud_fever_lines || 0;

  return {
    ok: true,
    generated: new Date().toLocaleString('en-US', { timeZone: 'America/La_Paz' }),
    generated_at: new Date().toISOString(),
    period_label: range.periodLabel,
    period_key: params.key || makePeriodKey_(params),
    report_name: 'Mud Fever Sales Report',
    brand_name: MUD_FEVER_BRAND_NAME,
    source_rule: 'Product title / line item title contains "Mud Fever"',
    summary: {
      gross_sales: round2_(grossSales),
      units_in_range: unitsInRange,
      net_sales: round2_(netSales),
      order_count: Object.keys(orderSeen).length,
      discount: round2_(totalDiscount),
      cogs: round2_(totalCogs),
      commercial_units_sold: commercialUnitsSold,
      marketing_units_seeded: marketingUnitsSeeded,
      credit_units: creditUnits,
      initial_stock_received: inventoryStatus.initial_stock_received,
      stock_received_date: inventoryStatus.stock_received_date,
      current_shopify_stock_available: inventoryStatus.current_shopify_stock_available,
      calculated_remaining: inventoryStatus.calculated_remaining,
      cumulative_units_sold: inventoryStatus.cumulative_commercial_units,
      cumulative_marketing_units: inventoryStatus.cumulative_marketing_units,
      starting_balance: inventoryStatus.period_opening_balance,
      ending_balance: inventoryStatus.period_ending_balance,
      wholesale_price: round2_(MUD_FEVER_WHOLESALE_PRICE),
      invoicing_basis: round2_(commercialUnitsSold * MUD_FEVER_WHOLESALE_PRICE),
      marketing_shipping_deductions: round2_(marketingShippingDeductions),
      credits_adjustments: round2_(creditsAdjustments),
      deductions_credits_total: round2_(marketingShippingDeductions + creditsAdjustments),
      net_total_to_invoice: round2_((commercialUnitsSold * MUD_FEVER_WHOLESALE_PRICE) - marketingShippingDeductions - creditsAdjustments),
      commercial_gross_sales: round2_(commercialGrossSales),
      commercial_net_sales: round2_(commercialNetSales),
      commercial_discount: round2_(commercialDiscount),
      commercial_cogs: round2_(commercialCogs),
      commercial_order_count: Object.keys(commercialOrderSeen).length,
      marketing_gross_value: round2_(marketingGrossValue),
      marketing_net_sales: round2_(marketingNetSales),
      marketing_cogs: round2_(marketingCogs),
      marketing_order_count: Object.keys(marketingOrderSeen).length
    },
    inventory_status: inventoryStatus,
    rows,
    reps: [],
    stats,
    warnings,
    config: {
      keyword: MUD_FEVER_KEYWORD,
      brand_name: MUD_FEVER_BRAND_NAME,
      cogs_source: 'Shopify Inventory Item cost via variant.inventory_item_id',
      permissions_needed: 'read_orders, read_products, read_inventory'
    }
  };
}

function appendMudFeverRefundRowsInRange_(order, range, costByVariant, ctx) {
  for (const refund of (order.refunds || [])) {
    if (!isDateInRange_(refund.created_at, range.startISO, range.endISO)) continue;
    for (const refLine of (refund.refund_line_items || [])) {
      const item = refLine.line_item || findLineItemById_(order, refLine.line_item_id);
      if (!item) continue;
      if (String(item.title || '').toLowerCase() === 'shipping') continue;
      if (!lineItemTitleHasMudFever_(item)) continue;
      const refundQty = parseInt(refLine.quantity || 0, 10);
      if (!refundQty) continue;
      const refundSubtotal = getRefundLineSubtotal_(refLine, item, refundQty);
      const variantId = item.variant_id ? String(item.variant_id) : '';
      const costInfo = variantId ? costByVariant[variantId] : null;
      const unitCogs = costInfo && costInfo.unit_cost !== null && costInfo.unit_cost !== undefined ? parseFloat(costInfo.unit_cost || 0) : 0;
      const cogsStatus = !variantId ? 'Missing variant_id' : (!costInfo ? 'COGS not found' : (costInfo.cost_missing ? 'COGS missing in Shopify' : 'OK'));
      if (cogsStatus !== 'OK') ctx.stats.cogs_missing_lines += 1;
      ctx.orderRows.push({
        order_id: order.name || order.id,
        order_numeric_id: order.id,
        order_date: refund.created_at || order.updated_at || order.created_at || '',
        original_order_date: order.created_at || '',
        refund_id: refund.id || '',
        customer: ctx.customerName,
        customer_email: ctx.customerEmail,
        rep: ctx.rep,
        rep_source: ctx.repSource,
        product: item.title || '',
        line_name: item.name || '',
        variant: item.variant_title || '',
        sku: item.sku || '',
        variant_id: variantId,
        quantity: -Math.abs(refundQty),
        gross: 0,
        discount: 0,
        net: round2_(-Math.abs(refundSubtotal)),
        unit_cogs: round2_(unitCogs),
        cogs: round2_(-Math.abs(unitCogs * refundQty)),
        cogs_status: cogsStatus,
        type: 'Credit/Return',
        reason: 'Refunded in selected period',
        order_tags: ctx.orderTags,
        customer_tags: ctx.customerTags,
        financial_status: order.financial_status || '',
        fulfillment_status: order.fulfillment_status || '',
        cancelled_at: order.cancelled_at || '',
        refund_created_at: refund.created_at || ''
      });
    }
  }
}

function findLineItemById_(order, lineItemId) {
  const id = String(lineItemId || '');
  return (order.line_items || []).find(item => String(item.id || '') === id) || null;
}

function getRefundLineSubtotal_(refLine, item, qty) {
  if (refLine.subtotal_set?.shop_money?.amount !== undefined) return parseFloat(refLine.subtotal_set.shop_money.amount || 0);
  if (refLine.subtotal !== undefined && refLine.subtotal !== null) return parseFloat(refLine.subtotal || 0);
  return parseFloat(item.price || 0) * Math.abs(qty || 0);
}

async function buildMudFeverInventoryStatus_(range, periodUnits) {
  const warnings = [];
  const hasInitialStock = MUD_FEVER_INITIAL_STOCK_RECEIVED !== null && MUD_FEVER_INITIAL_STOCK_RECEIVED !== undefined && !isNaN(MUD_FEVER_INITIAL_STOCK_RECEIVED);
  const hasReceiptDate = !!MUD_FEVER_STOCK_RECEIVED_DATE;
  const initialStock = hasInitialStock ? MUD_FEVER_INITIAL_STOCK_RECEIVED : null;
  const receiptStart = hasReceiptDate ? `${MUD_FEVER_STOCK_RECEIVED_DATE}T00:00:00Z` : '';
  const beforePeriodEnd = new Date(range.startDate.getTime() - 1000);
  const beforePeriodEndISO = toShopifyISO_(beforePeriodEnd);
  const liveInventory = await fetchMudFeverLiveInventory_();
  const canCalculateInventoryMovement = hasInitialStock && hasReceiptDate;
  const beforeSummary = canCalculateInventoryMovement ? await summarizeMudFeverUnitsBetween_(receiptStart, beforePeriodEndISO) : { commercial_units: 0, marketing_units: 0, total_units: 0, orders: 0 };
  const throughSummary = canCalculateInventoryMovement ? await summarizeMudFeverUnitsBetween_(receiptStart, range.endISO) : { commercial_units: 0, marketing_units: 0, total_units: 0, orders: 0 };

  if (beforeSummary.error) warnings.push(beforeSummary.error);
  if (throughSummary.error) warnings.push(throughSummary.error);
  if (liveInventory.warning) warnings.push(liveInventory.warning);

  const liveAtLocation = liveInventory.location_available;
  const hasLiveAtLocation = liveAtLocation !== null && liveAtLocation !== undefined && !isNaN(liveAtLocation);
  let periodOpening = null;
  let calculatedRemaining = null;
  let periodEnding = null;
  let inventoryMode = '';

  if (canCalculateInventoryMovement) {
    periodOpening = round2_(initialStock - (beforeSummary.commercial_units || 0) - (beforeSummary.marketing_units || 0));
    calculatedRemaining = round2_(initialStock - (throughSummary.commercial_units || 0) - (throughSummary.marketing_units || 0));
    periodEnding = round2_(periodOpening - (periodUnits.period_commercial_units || 0) - (periodUnits.period_marketing_units || 0));
    inventoryMode = 'received_stock_ledger';
  } else if (hasLiveAtLocation) {
    periodEnding = round2_(liveAtLocation);
    periodOpening = round2_(liveAtLocation + (periodUnits.period_commercial_units || 0) + (periodUnits.period_marketing_units || 0));
    calculatedRemaining = round2_(liveAtLocation);
    inventoryMode = 'live_shopify_stock_fallback';
    warnings.push('MUD_FEVER_INITIAL_STOCK_RECEIVED and MUD_FEVER_STOCK_RECEIVED_DATE are not configured. Opening/ending stock use live Shopify stock fallback.');
  } else {
    inventoryMode = 'not_available';
    warnings.push(`No live Shopify inventory found for product title keyword "${MUD_FEVER_KEYWORD}" at ${MUD_FEVER_LOCATION_NAME}.`);
  }

  return {
    initial_stock_received: initialStock,
    stock_received_date: MUD_FEVER_STOCK_RECEIVED_DATE,
    sku: MUD_FEVER_SKU || '',
    inventory_lookup: MUD_FEVER_SKU ? `SKU: ${MUD_FEVER_SKU}` : `Product title contains: ${MUD_FEVER_BRAND_NAME}`,
    location_id: MUD_FEVER_LOCATION_ID,
    location_name: MUD_FEVER_LOCATION_NAME,
    inventory_mode: inventoryMode,
    period_opening_balance: periodOpening,
    period_ending_balance: periodEnding,
    calculated_remaining: calculatedRemaining,
    cumulative_commercial_units: throughSummary.commercial_units || 0,
    cumulative_marketing_units: throughSummary.marketing_units || 0,
    cumulative_total_units: throughSummary.total_units || 0,
    current_shopify_stock_available: liveInventory.location_available,
    total_shopify_stock_available: liveInventory.total_available,
    inventory_item_id: liveInventory.inventory_item_id || '',
    matched_variants_count: liveInventory.matched_variants_count || 0,
    matched_skus: liveInventory.matched_skus || [],
    inventory_locations: liveInventory.locations || [],
    warning: warnings.join(' | ')
  };
}

async function summarizeMudFeverUnitsBetween_(startISO, endISO) {
  if (!startISO || !endISO || new Date(endISO) < new Date(startISO)) return { commercial_units: 0, marketing_units: 0, total_units: 0, orders: 0 };
  const orders = await fetchAllActivityOrders_(startISO, endISO);
  if (orders.error) return { commercial_units: 0, marketing_units: 0, total_units: 0, orders: 0, error: orders.error };
  const out = { commercial_units: 0, marketing_units: 0, total_units: 0, orders: 0 };
  const seen = {};
  for (const order of (orders || [])) {
    let hasVendorActivity = false;
    if (isDateInRange_(order.created_at, startISO, endISO)) {
      for (const item of (order.line_items || [])) {
        if (String(item.title || '').toLowerCase() === 'shipping') continue;
        if (!lineItemTitleHasMudFever_(item)) continue;
        hasVendorActivity = true;
        const qty = parseInt(item.quantity || 0, 10);
        const gross = parseFloat(item.price || 0) * qty;
        const discounts = (item.discount_allocations || []).reduce((s, d) => s + parseFloat(d.amount || 0), 0);
        const net = round2_(gross - discounts);
        const marketingReason = getMarketingReason_(order, item);
        const isLikelyFree = gross > 0 && discounts >= gross * 0.95;
        if (qty <= 0 || net < 0) continue;
        if (marketingReason || net === 0 || isLikelyFree) out.marketing_units += Math.max(qty, 0);
        else out.commercial_units += Math.max(qty, 0);
        out.total_units += Math.max(qty, 0);
      }
    }
    for (const refund of (order.refunds || [])) {
      if (!isDateInRange_(refund.created_at, startISO, endISO)) continue;
      for (const refLine of (refund.refund_line_items || [])) {
        const item = refLine.line_item || findLineItemById_(order, refLine.line_item_id);
        if (!item || !lineItemTitleHasMudFever_(item)) continue;
        hasVendorActivity = true;
        const refundQty = Math.abs(parseInt(refLine.quantity || 0, 10));
        out.commercial_units -= refundQty;
        out.total_units -= refundQty;
      }
    }
    if (hasVendorActivity) seen[String(order.id)] = true;
  }
  out.orders = Object.keys(seen).length;
  return out;
}

async function fetchMudFeverLiveInventory_() {
  const fallback = { location_available: null, total_available: null, inventory_item_id: '', matched_variants_count: 0, matched_skus: [], locations: [], warning: '' };
  try {
    const hasSku = !!MUD_FEVER_SKU;
    const searchQuery = hasSku ? `sku:${MUD_FEVER_SKU}` : MUD_FEVER_KEYWORD;
    const query = 'query($q:String!){ productVariants(first:50, query:$q){ edges{ node{ id sku title product{ title } inventoryItem{ id inventoryLevels(first:50){ edges{ node{ location{ id name } quantities(names:["available"]){ name quantity } } } } } } } } } }';
    const data = await shopGraphql_(query, { q: searchQuery });
    const edges = data?.data?.productVariants?.edges || [];
    if (!edges.length) {
      fallback.warning = hasSku ? `No Shopify variant found for SKU ${MUD_FEVER_SKU}.` : `No Shopify variant found by product title keyword "${MUD_FEVER_KEYWORD}".`;
      return fallback;
    }
    const targetKeyword = normalizeLoose_(MUD_FEVER_KEYWORD);
    let locationAvailable = 0;
    let totalAvailable = 0;
    let matchedCount = 0;
    const matchedSkus = [];
    const inventoryItemIds = [];
    const locationMap = {};
    for (const edge of edges) {
      const node = edge?.node || {};
      const productTitle = node.product?.title || '';
      const haystack = normalizeLoose_([productTitle, node.title || '', node.sku || ''].join(' '));
      if (!hasSku && haystack.indexOf(targetKeyword) === -1) continue;
      matchedCount += 1;
      if (node.sku) matchedSkus.push(node.sku);
      const item = node.inventoryItem || {};
      if (item.id) inventoryItemIds.push(String(item.id).split('/').pop());
      const levels = item.inventoryLevels?.edges || [];
      for (const levelEdge of levels) {
        const lvl = levelEdge?.node || {};
        const loc = lvl.location || {};
        const locId = String(loc.id || '').split('/').pop();
        const locName = loc.name || '';
        let qty = 0;
        for (const q of (lvl.quantities || [])) if (String(q.name || '').toLowerCase() === 'available') qty = parseFloat(q.quantity || 0);
        totalAvailable += parseFloat(qty || 0);
        const key = locId || normalizeLoose_(locName);
        if (!locationMap[key]) locationMap[key] = { location_id: locId, location_gid: loc.id || '', location_name: locName, available: 0 };
        locationMap[key].available += parseFloat(qty || 0);
        if (String(locId) === String(MUD_FEVER_LOCATION_ID) || normalizeLoose_(locName) === normalizeLoose_(MUD_FEVER_LOCATION_NAME)) locationAvailable += parseFloat(qty || 0);
      }
    }
    if (!matchedCount) {
      fallback.warning = `Variants were returned from Shopify, but none matched product title keyword "${MUD_FEVER_KEYWORD}" after filtering.`;
      return fallback;
    }
    const locations = Object.values(locationMap).map(l => ({ ...l, available: round2_(l.available) }));
    return {
      location_available: round2_(locationAvailable),
      total_available: round2_(totalAvailable),
      inventory_item_id: inventoryItemIds.join(', '),
      matched_variants_count: matchedCount,
      matched_skus: unique_(matchedSkus),
      locations,
      warning: matchedCount && locationAvailable === 0 ? `Matched ${matchedCount} variant(s), but available stock at ${MUD_FEVER_LOCATION_NAME} is 0.` : ''
    };
  } catch (e) {
    fallback.warning = `Unable to fetch live Shopify inventory for product title keyword "${MUD_FEVER_KEYWORD}": ${e.message}`;
    return fallback;
  }
}

async function shopGraphql_(query, variables) {
  const url = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Shopify GraphQL returned HTTP ${resp.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body;
}

async function fetchAllActivityOrders_(startISO, endISO) {
  const created = await fetchOrdersByDateField_(startISO, endISO, 'created_at');
  if (created?.error) return created;
  const updated = await fetchOrdersByDateField_(startISO, endISO, 'updated_at');
  if (updated?.error) return updated;
  const map = {};
  for (const o of created || []) map[String(o.id)] = o;
  for (const o of updated || []) map[String(o.id)] = o;
  return Object.values(map);
}

async function fetchOrdersByDateField_(startISO, endISO, dateField) {
  const params = {
    status: 'any',
    limit: 250,
    fields: 'id,name,email,contact_email,tags,created_at,updated_at,line_items,customer,note,note_attributes,financial_status,fulfillment_status,cancelled_at,cancel_reason,refunds,total_shipping_price_set,total_shipping_price,shipping_lines'
  };
  params[`${dateField}_min`] = startISO;
  params[`${dateField}_max`] = endISO;
  return fetchAllPages_(shopUrl_('/orders.json', params), 'orders');
}

async function prefetchMudFeverVariantCosts_(orders) {
  const warnings = [];
  const variantIdSet = {};
  for (const order of (orders || [])) {
    for (const item of (order.line_items || [])) {
      if (!lineItemTitleHasMudFever_(item)) continue;
      if (item.variant_id) variantIdSet[String(item.variant_id)] = true;
    }
  }
  const variantIds = Object.keys(variantIdSet);
  if (!variantIds.length) return { costByVariant: {}, warnings, missingVariantCount: 0 };
  const variantToInventoryItem = {};
  const inventoryItemSet = {};
  for (const variantId of variantIds) {
    const resp = await shopFetch_(shopUrl_(`/variants/${encodeURIComponent(variantId)}.json`, { fields: 'id,inventory_item_id,sku' }));
    if (!resp.ok) {
      warnings.push(`Variant fetch failed for variant_id ${variantId} · HTTP ${resp.status}`);
      continue;
    }
    const body = await resp.json();
    const invId = body.variant?.inventory_item_id ? String(body.variant.inventory_item_id) : '';
    if (invId) {
      variantToInventoryItem[variantId] = invId;
      inventoryItemSet[invId] = true;
    } else warnings.push(`No inventory_item_id found for variant_id ${variantId}`);
  }
  const inventoryItemIds = Object.keys(inventoryItemSet);
  const costByInventoryItem = {};
  for (let i = 0; i < inventoryItemIds.length; i += INVENTORY_ITEMS_BATCH_SIZE) {
    const ids = inventoryItemIds.slice(i, i + INVENTORY_ITEMS_BATCH_SIZE);
    const resp = await shopFetch_(shopUrl_('/inventory_items.json', { ids: ids.join(','), limit: 250, fields: 'id,cost,sku' }));
    if (!resp.ok) {
      warnings.push(`Inventory item cost fetch failed · HTTP ${resp.status}. COGS will show as $0 for affected lines. Check read_inventory permission.`);
      continue;
    }
    const body = await resp.json();
    for (const inv of (body.inventory_items || [])) {
      const id = String(inv.id);
      costByInventoryItem[id] = inv.cost === null || inv.cost === undefined || inv.cost === '' ? null : parseFloat(inv.cost || 0);
    }
    await sleep_(FETCH_DELAY_MS);
  }
  const costByVariant = {};
  let missingVariantCount = 0;
  for (const variantId of variantIds) {
    const invId = variantToInventoryItem[variantId] || '';
    const unitCost = invId ? costByInventoryItem[invId] : null;
    const costMissing = unitCost === null || unitCost === undefined || isNaN(unitCost);
    if (costMissing) missingVariantCount += 1;
    costByVariant[variantId] = { inventory_item_id: invId, unit_cost: costMissing ? 0 : round2_(unitCost), cost_missing: costMissing };
  }
  return { costByVariant, warnings, missingVariantCount };
}

async function shopFetch_(url) {
  return fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
}

async function fetchAllPages_(url, rootKey) {
  const out = [];
  let nextUrl = url;
  while (nextUrl) {
    const resp = await shopFetch_(nextUrl);
    const text = await resp.text();
    if (!resp.ok) return { error: `Shopify API returned ${resp.status} for ${rootKey}: ${text.slice(0, 300)}` };
    const body = JSON.parse(text);
    out.push(...(body[rootKey] || []));
    const link = resp.headers.get('link') || '';
    const m = String(link).match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = m ? m[1] : null;
    if (nextUrl) await sleep_(FETCH_DELAY_MS);
  }
  return out;
}

function buildPeriods_() {
  const now = new Date();
  const weeks = [];
  const months = [];
  const quarters = [];

  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  for (let i = 0; i < 12; i++) {
    const mon = new Date(thisMonday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const sun = new Date(mon.getTime() + 6 * 24 * 60 * 60 * 1000);
    let label = `${fmtShort_(mon)} – ${fmtShort_(sun)}`;
    if (i === 0) label = `This week · ${label}`;
    if (i === 1) label = `Last week · ${label}`;
    const params = { mode: 'week', startISO: isoDay_(mon), endISO: isoDay_(sun), label };
    weeks.push({ key: makePeriodKey_(params), label, params });
  }

  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    const label = `${monthName_(m)} ${y}${i === 0 ? ' (month in progress)' : ''}`;
    const params = { mode: 'month', year: y, month: m, startISO: `${y}-${pad2_(m)}-01`, endISO: `${y}-${pad2_(m)}-${pad2_(last)}`, label: label.replace(' (month in progress)', '') };
    months.push({ key: makePeriodKey_(params), label, params });
  }

  const curQ = Math.floor(now.getMonth() / 3) + 1;
  for (let i = 0; i < 8; i++) {
    const total = (now.getFullYear() * 4 + curQ - 1) - i;
    const y = Math.floor(total / 4);
    const q = (total % 4) + 1;
    const params = { mode: 'quarter', year: y, quarter: q };
    quarters.push({ key: makePeriodKey_(params), label: `Q${q} ${y}`, params });
  }
  return { weeks, months, quarters };
}

function resolveDateRange_(params) {
  const now = new Date();
  let startDate, endDate, periodLabel;
  const mode = String(params.mode || '').toLowerCase();
  if (params.startISO && params.endISO) {
    startDate = new Date(`${params.startISO}T00:00:00`);
    endDate = new Date(`${params.endISO}T23:59:59`);
    if (endDate > now) endDate = now;
    periodLabel = params.label || `${params.startISO} – ${params.endISO}`;
  } else if ((mode === 'month' && params.month) || (params.month && !params.quarter)) {
    const year = parseInt(params.year || now.getFullYear(), 10);
    const month = parseInt(params.month, 10);
    startDate = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59);
    endDate = monthEnd > now ? now : monthEnd;
    periodLabel = `${monthName_(month)} ${year}`;
  } else if ((mode === 'quarter' && params.quarter) || params.quarter) {
    const qYear = parseInt(params.year || now.getFullYear(), 10);
    const q = parseInt(params.quarter, 10);
    const startMonth = (q - 1) * 3;
    startDate = new Date(qYear, startMonth, 1);
    const qEnd = new Date(qYear, startMonth + 3, 0, 23, 59, 59);
    endDate = qEnd > now ? now : qEnd;
    periodLabel = `Q${q} ${qYear}`;
  } else {
    endDate = now;
    startDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    periodLabel = 'Last 60 days';
  }
  return { startDate, endDate, startISO: toShopifyISO_(startDate), endISO: toShopifyISO_(endDate), periodLabel };
}

function makePeriodKey_(params) {
  if (params.mode === 'week') return `week:${params.startISO}:${params.endISO}`;
  if (params.mode === 'month') return `month:${params.year}:${params.month}`;
  if (params.mode === 'quarter') return `quarter:${params.year}:${params.quarter}`;
  return `custom:${params.startISO || ''}:${params.endISO || ''}`;
}

function shopUrl_(apiPath, params = {}) {
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `https://${STORE}/admin/api/${API_VERSION}${apiPath}${qs ? `?${qs}` : ''}`;
}

function lineItemTitleHasMudFever_(item) { return normalizeLoose_([item.title || '', item.name || ''].join(' ')).indexOf(MUD_FEVER_KEYWORD) !== -1; }
function getCustomerEmail_(order) { return order.email || order.contact_email || order.customer?.email || ''; }
function getOrderShipping_(order) {
  if (!order) return 0;
  if (order.total_shipping_price_set?.shop_money?.amount !== undefined) return round2_(parseFloat(order.total_shipping_price_set.shop_money.amount || 0));
  if (order.total_shipping_price !== undefined && order.total_shipping_price !== null && order.total_shipping_price !== '') return round2_(parseFloat(order.total_shipping_price || 0));
  return round2_((order.shipping_lines || []).reduce((s, sl) => s + parseFloat(sl.price || 0), 0));
}
function getMarketingReason_(order, item) {
  const chunks = [order.tags || '', order.note || ''];
  if (order.customer) chunks.push(order.customer.tags || '');
  for (const a of (order.note_attributes || [])) chunks.push(a.name || a.key || '', a.value || '');
  for (const p of (item.properties || [])) chunks.push(p.name || p.key || '', p.value || '');
  chunks.push(item.title || '', item.name || '');
  const text = normalizeLoose_(chunks.join(' '));
  for (const term of MARKETING_TERMS) if (text.indexOf(normalizeLoose_(term)) !== -1) return `Marketing marker: ${term}`;
  return '';
}
function extractRep_(customerTags, orderTags) {
  const customerList = splitTags_(customerTags);
  const orderList = splitTags_(orderTags);
  for (const tag of customerList) if (VALID_REPS.includes(String(tag || '').trim().toUpperCase())) return { rep: tag.toUpperCase(), source: 'Customer tag' };
  for (const tag of orderList) if (VALID_REPS.includes(String(tag || '').trim().toUpperCase())) return { rep: tag.toUpperCase(), source: 'Order tag' };
  return { rep: null, source: null };
}
function isDateInRange_(dateStr, startISO, endISO) { if (!dateStr) return false; const t = new Date(dateStr).getTime(); return t >= new Date(startISO).getTime() && t <= new Date(endISO).getTime(); }
function cleanStore_(value) { return String(value || '').replace(/^https?:\/\//, '').replace(/\/$/, '').trim(); }
function validateConfig_() { if (!STORE) throw new Error('Missing SHOPIFY_STORE secret'); if (!TOKEN) throw new Error('Missing SHOPIFY_TOKEN secret'); }
function normalizeTag_(tag) { return String(tag || '').trim().toLowerCase(); }
function normalizeLoose_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function splitTags_(tags) { return String(tags || '').split(',').map(normalizeTag_).filter(Boolean); }
function sortByDateDesc_(a, b) { return new Date(b.order_date) - new Date(a.order_date); }
function toShopifyISO_(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function isoDay_(d) { return `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}-${pad2_(d.getDate())}`; }
function pad2_(n) { return n < 10 ? `0${n}` : String(n); }
function fmtShort_(d) { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate(); }
function monthName_(m) { return ['','January','February','March','April','May','June','July','August','September','October','November','December'][m]; }
function round2_(n) { return Math.round((parseFloat(n || 0)) * 100) / 100; }
function unique_(arr) { return [...new Set((arr || []).filter(Boolean).map(String))]; }
function sleep_(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

main().catch(err => {
  console.error(err);
  process.exit(1);
});
