import test from 'node:test';
import assert from 'node:assert/strict';
import { browserOrderGuards, prepareWebOrder, prepareProfileWebOrder, submitApprovedWebOrder, cancelWebOrder,
  beginOperatorWebOrder, registerOperatorSelection, registerOperatorPreparedCart,
  verifyOperatorSubmissionApproval, startOperatorSubmission, registerOperatorReceipt } from '../lib/browser-order.mjs';

test('requested branch identity preserves direction and unit while tolerating address word order', () => {
  const { branchMatches } = browserOrderGuards;
  assert.equal(branchMatches('650 W Georgia St, Vancouver BC V6B 0S6', 'Pick Up 650 Georgia Street W Vancouver'), true);
  assert.equal(branchMatches('650 W Georgia St Vancouver', 'Pick Up 650 East Georgia Street Vancouver'), false);
  assert.equal(branchMatches('Suite 3 650 W Georgia St Vancouver', 'Pick Up Suite 2 650 Georgia Street W Vancouver'), false);
  assert.equal(branchMatches('Suite 3 650 W Georgia St Vancouver', 'Pick Up 650 Georgia Street W Vancouver'), false);
  assert.equal(branchMatches('Suite 3 650 W Georgia St Vancouver', 'Pick Up Suite 3 650 Georgia Street W Vancouver'), true);
  assert.equal(branchMatches('1055 West Georgia Street Unit118', 'Pick Up 1055 West Georgia Street Unit2468'), false);
  assert.equal(branchMatches('#3 650 West Georgia Street', 'Pick Up Suite 3 650 Georgia Street West'), true);
});

test('actual item-bearing Add labels trigger the branch/cart safety gate', () => {
  assert.equal(browserOrderGuards.isAddToCartLabel('Add 1 Brewed Coffee to order for $1.92'), true);
  assert.equal(browserOrderGuards.isAddToCartLabel('Add 2 Lattes to bag'), true);
  assert.equal(browserOrderGuards.isAddToCartLabel('Your Address'), false);
});

test('planner target IDs accept bounded numeric strings but cannot become selectors or fractional ids', () => {
  assert.equal(browserOrderGuards.actionTargetId('12'), 12);
  assert.equal(browserOrderGuards.actionTargetId(12), 12);
  assert.equal(browserOrderGuards.actionTargetId('button:nth-child(12)'), null);
  assert.equal(browserOrderGuards.actionTargetId('12.5'), null);
  assert.equal(browserOrderGuards.actionTargetId(141), null);
});

test('existing carts and package/customization evidence cannot silently change the requested order', () => {
  const job = { items: [{ request: 'Small Black Brewed Coffee', quantity: 1 }] };
  assert.equal(browserOrderGuards.inspectExistingCart(job, { controls: [{ label: '0 Cart Total' }], visibleText: '' }).state, 'checked');
  const view = { controls: [{ label: '1 Cart' }], visibleText: 'Your order Croissant Quantity 1 $3.00' };
  const action = { existing_cart_checked: true, existing_cart_items: [{ name_quote: 'Croissant', quantity_quote: 'Quantity 1' }] };
  assert.equal(browserOrderGuards.inspectExistingCart(job, view, action).state, 'other');
  assert.equal(browserOrderGuards.matchesRequestedItem('10 pack chocolate Timbits', ['20 Timbits Pack', 'Chocolate', '$10.00']), false);
  assert.equal(browserOrderGuards.matchesRequestedItem('10 pack chocolate Timbits', ['10 Timbits Pack', 'Chocolate']), true);
  assert.equal(browserOrderGuards.matchesRequestedItem('Large Double Double Brewed Coffee', ['Brewed Coffee', 'Large', '2 Cream', '2 Sugar'], true), true);
  assert.equal(browserOrderGuards.matchesRequestedItem('Large Double Double Brewed Coffee', ['Brewed Coffee', 'Large', '2 Cream', '2 Sugar'], false), false);
  assert.equal(browserOrderGuards.matchesRequestedItem('Large Double Double Brewed Coffee', ['Brewed Coffee', 'Large', '2 Cream', '3 Sugar'], true), false);
});

test('delivery evidence must preserve street, postal code and named drop-off details', () => {
  const requested = '570 Dunsmuir St Vancouver BC V6B1Y1 Alexander College AIC Founders Lab';
  const actual = 'Delivery 570 Dunsmuir Street Vancouver BC V6B 1Y1 Alexander College AIC Founders Lab';
  assert.equal(browserOrderGuards.deliveryAddressMatches(requested, actual), true);
  assert.equal(browserOrderGuards.deliveryAddressMatches(requested, actual.replace('570', '580')), false);
  assert.equal(browserOrderGuards.deliveryAddressMatches(requested, actual.replace('V6B 1Y1', 'V6B 1Y2')), false);
  assert.equal(browserOrderGuards.deliveryAddressMatches(requested, actual.replace('Alexander College AIC Founders Lab', 'Front desk')), false);
});

test('operator delivery modifier capture can use the confirmed street before checkout shows full details', () => {
  const job = { serviceMode: 'delivery', deliveryAddressConfirmed: true,
    deliveryAddress: '570 Dunsmuir Street Vancouver BC V6B1Y1 Alexander College AIC Founders Lab' };
  assert.equal(browserOrderGuards.operatorSelectionLocation(job, { pickupAreas: ['Delivery 570 Dunsmuir Street'] }), 'Delivery 570 Dunsmuir Street');
  assert.equal(browserOrderGuards.operatorSelectionLocation(job, { pickupAreas: ['Pick Up 570 Dunsmuir Street'] }), null);
  assert.equal(browserOrderGuards.operatorSelectionLocation(job, { pickupAreas: ['Delivery 580 Dunsmuir Street'] }), null);
  assert.equal(browserOrderGuards.operatorSelectionLocation({ ...job, deliveryAddressConfirmed: false }, { pickupAreas: ['Delivery 570 Dunsmuir Street'] }), null);
});

test('a visible delivery choice cannot stand in for actual selected delivery', () => {
  const address = '570 Dunsmuir St Vancouver BC V6B1Y1';
  const view = { visibleText: `Pick Up 650 W Georgia St Delivery ${address}`,
    controls: [], pickupAreas: ['Pick Up 650 W Georgia St', 'Delivery'] };
  const evidence = { selected_service_mode_quote: 'Delivery', delivery_address_quote: address };
  assert.equal(browserOrderGuards.selectedServiceEvidence({ serviceMode: 'delivery', deliveryAddress: address },
    view, evidence, 'Pick Up 650 W Georgia St'), null);
  const chosen = { ...view, visibleText: `Ordering from 650 W Georgia St Delivery ${address}`,
    pickupAreas: [`Delivery ${address}`] };
  assert.ok(browserOrderGuards.selectedServiceEvidence({ serviceMode: 'delivery', deliveryAddress: address },
    chosen, { ...evidence, selected_service_mode_quote: `Delivery ${address}` }, 'Ordering from 650 W Georgia St'));
});

test('purchase and account controls are blocked while a locator Order label remains usable', () => {
  for (const label of ['Place Order', 'Place Delivery order for $15.98', 'Place Pickup Order', 'Place Secure Order', 'Pay $5.00', 'Confirm Purchase', 'Submit Order', 'Sign In']) {
    assert.equal(browserOrderGuards.isBlockedControl(label), true, label);
  }
  assert.equal(browserOrderGuards.isBlockedControl('Order'), false);
  assert.equal(browserOrderGuards.isBlockedControl('Checkout'), false);
  assert.equal(browserOrderGuards.allowedUrl('https://www.timhortons.ca/checkout'), true);
  assert.equal(browserOrderGuards.allowedUrl('https://example.com/menu'), false);
});

test('approval requires the identical total, explicit Tim Card selection and sufficient visible balance', () => {
  const data = { approvedTotal: 2.02, budgetCad: 10, lockedTotal: 2.02, actualTotal: 2.02,
    paymentQuote: 'Payment method: Tim Card', balanceQuote: 'Tim Card balance $10.00',
    checkedPaymentLabels: [], finalControlLabel: 'Place Order',
    visibleText: 'Payment method: Tim Card Tim Card balance $10.00 Total $2.02' };
  const check = browserOrderGuards.validateApprovalEvidence;
  assert.equal(check(data).allowed, true);
  const gift = { ...data, paymentQuote: 'Payment method: Tims Gift Card', balanceQuote: 'Tims Gift Card balance $10.00',
    visibleText: 'Payment method: Tims Gift Card Tims Gift Card balance $10.00 Total $2.02' };
  assert.equal(check(gift).allowed, true);
  assert.equal(check({ ...gift, paymentQuote: 'Tims Gift Card $10.00',
    visibleText: 'Tims Gift Card $10.00 Tims Gift Card balance $10.00 Total $2.02' }).allowed, false);
  assert.equal(check({ ...data, actualTotal: 2.03 }).allowed, false);
  assert.equal(check({ ...data, budgetCad: 2 }).allowed, false);
  assert.equal(check({ ...data, paymentQuote: 'Tim Card' }).allowed, false);
  assert.equal(check({ ...data, checkedPaymentLabels: ['Visa ending 1234'] }).allowed, false);
  assert.equal(check({ ...data, balanceQuote: 'Tim Card balance $1.00', visibleText: 'Payment method: Tim Card Tim Card balance $1.00' }).allowed, false);
  assert.equal(check({ ...data, balanceQuote: 'Tim Card balance $10.00 $2.02', visibleText: 'Payment method: Tim Card Tim Card balance $10.00 $2.02' }).allowed, false);
  assert.equal(check({ ...data, finalControlLabel: 'Pay $2.02' }).allowed, false);
});

test('live checkout gift-card balance must belong to the selected rendered card, and final label total must match', () => {
  const selected = { label: 'Your selected payment method is Tim card', context: 'Tims Gift Card •••• 7044 - $20.00 Your selected payment method is Tim card' };
  const data = { approvedTotal: 15.98, budgetCad: 100, lockedTotal: 15.98, actualTotal: 15.98,
    paymentQuote: selected.label, balanceQuote: 'Tims Gift Card •••• 7044 - $20.00',
    selectedPaymentControls: [selected], finalControlLabel: 'Place Delivery order for $15.98',
    visibleText: `${selected.context} Total $15.98` };
  const check = browserOrderGuards.validateApprovalEvidence;
  assert.equal(check(data).allowed, true);
  assert.equal(check({ ...data, selectedPaymentControls: [] }).allowed, false, 'Header card amount alone cannot prove its selected payment balance');
  assert.equal(check({ ...data, selectedPaymentControls: [{ ...selected, context: 'MASTERCARD •••• 4481 exp. 07/29' }] }).allowed, false, 'Stale Tim-card aria label cannot override the displayed credit card');
  assert.equal(check({ ...data, balanceQuote: 'Tims Gift Card balance $20.00', selectedPaymentControls: [{ ...selected, context: 'MASTERCARD •••• 4481 exp. 07/29' }], visibleText: `${selected.label} Tims Gift Card balance $20.00 Total $15.98` }).allowed, false, 'An explicitly labelled header balance cannot override the actual selected credit card');
  assert.equal(check({ ...data, finalControlLabel: 'Place Delivery order for $18.14' }).allowed, false);
  assert.equal(check({ ...data, balanceQuote: 'Tims Gift Card •••• 7044 - $10.00', selectedPaymentControls: [{ ...selected, context: selected.context.replace('$20.00', '$10.00') }], visibleText: selected.context.replace('$20.00', '$10.00') }).allowed, false);
});

test('missing demo-time inputs ask the person before any browser launch', async () => {
  const result = await prepareWebOrder({ config: {} });
  assert.equal(result.status, 'waiting_user');
  assert.equal(result.order_submitted, false);
  assert.equal(result.steps, 0);
  assert.ok(result.remaining_questions.some(value => /branch/.test(value)));
});

test('a delivery address cannot be used without strict trusted confirmation', async () => {
  const result = await prepareWebOrder({ branchAddress: '100 Example St', items: [{ name: 'small black coffee', quantity: 1 }],
    serviceMode: 'delivery', deliveryAddress: '200 Sample St', deliveryAddressConfirmed: 'yes',
    config: { OPENROUTER_API_KEY: 'fixture' } });
  assert.equal(result.status, 'waiting_user');
  assert.equal(result.steps, 0);
  assert.match(result.spoken, /200 Sample St/);
  assert.equal(result.order_submitted, false);
});

test('DOM-only profile review needs no browser, and a changed total prevents any final click', async () => {
  const previousFetch = globalThis.fetch;
  const branch = '650 W Georgia St', quote = `Pick Up ${branch}`;
  const controls = [{ id: 1, label: quote, tag: 'button' },
    { id: 2, label: 'Tim Card', tag: 'input', checked: true }, { id: 3, label: 'Place Order', tag: 'button' }];
  const evidence = { action: 'review', selected_service_mode_quote: quote,
    cart_items: [{ request_index: 0, name_quote: 'Brewed Coffee', quantity_quote: 'Quantity 1',
      customization_quotes: ['Small', 'Black'], price_quote: '$1.92' }], total_quote: 'Total $2.02',
    payment_quote: 'Payment method: Tim Card', balance_quote: 'Tim Card balance $10.00', final_target_id: 3 };
  const requests = [], actions = [];
  let views = 0, prepared;
  const driver = { navigate: async url => assert.match(url, /^https:\/\/(?:www\.)?timhortons\.ca\//),
    snapshot: async step => { views++; return { url: 'https://www.timhortons.ca/checkout', revision: `fixture-${step}`,
      visibleText: `Your order ${quote} Brewed Coffee Quantity 1 Small Black $1.92 ${views > 2 ? 'Total $2.03' : 'Total $2.02'} Payment method: Tim Card Tim Card balance $10.00 Place Order`,
      controls, pickupAreas: [quote] }; }, action: async action => { actions.push(action); return { ok: true }; } };
  globalThis.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(evidence) } }] }), { status: 200 });
  };
  try {
    prepared = await prepareProfileWebOrder({ branchAddress: branch, items: [{ name: 'Brewed Coffee', quantity: 1, options: ['Small', 'Black'] }],
      profileDriver: driver, config: { OPENROUTER_API_KEY: 'offline-fixture' } });
    assert.equal(prepared.status, 'cart_ready'); assert.equal(prepared.total_cad, 2.02);
    assert.ok(requests.every(request => request.messages[1].content.every(part => part.type === 'text')));
    const result = await submitApprovedWebOrder(prepared.job_id, { approvedTotal: 2.02, budgetCad: 10 });
    assert.equal(result.status, 'needs_takeover'); assert.equal(result.purchase_attempted, false);
    assert.equal(actions.length, 0, 'A changed fresh total must stop before an extension click');
  } finally { globalThis.fetch = previousFetch; if (prepared?.job_id) await cancelWebOrder(prepared.job_id); }
});

test('operator registration cannot certify Double Double without a fresh actual checked selection', async () => {
  const branch = '650 W Georgia St', pickup = `Pick Up ${branch}`;
  let mode = 'cart', actions = 0;
  const driver = { navigate: async () => { actions++; }, action: async () => { actions++; },
    snapshot: async step => ({ url: 'https://www.timhortons.ca/menu', revision: `operator-fixture-${step}`,
      visibleText: mode === 'picker' ? `${pickup} Brewed Coffee Large Double Double Add 1 Brewed Coffee to order for $2.85`
        : `Your order ${pickup} Brewed Coffee Quantity 1 Large 2 Cream 2 Sugar $2.85 Total $2.99`,
      pickupAreas: [pickup], controls: mode === 'picker'
        ? [{ id: 1, label: 'Double Double', checked: true, tag: 'input' },
          { id: 2, label: 'Add 1 Brewed Coffee to order for $2.85', tag: 'button' },
          { id: 3, label: 'Size Large', tag: 'button' }]
        : [{ id: 1, label: '1 Cart', tag: 'button' }] }) };
  const started = beginOperatorWebOrder({ branchAddress: branch, items: [{ name: 'Large Double Double Brewed Coffee', quantity: 1 }], profileDriver: driver });
  const evidence = { selected_service_mode_quote: pickup, cart_items: [{ request_index: 0, name_quote: 'Brewed Coffee',
    quantity_quote: 'Quantity 1', customization_quotes: ['Large', '2 Cream', '2 Sugar'], price_quote: '$2.85' }], total_quote: 'Total $2.99' };
  try {
    const without = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence,
      selectionEvidence: [{ checked_quotes: ['Double Double'] }] });
    assert.equal(without.status, 'needs_review');
    mode = 'picker';
    const checked = await registerOperatorSelection(started.job_id, { requestIndex: 0 });
    assert.equal(checked.recorded, true);
    mode = 'cart';
    const after = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence });
    assert.equal(after.status, 'cart_ready'); assert.equal(after.total_cad, 2.99);
    assert.equal(after.order_submitted, false); assert.equal(actions, 0, 'Operator registration never acts on the browser');
  } finally { await cancelWebOrder(started.job_id); }
});

test('spoken quantities keep individual Timbits and boxes distinct without opening a browser', async () => {
  const driver = { navigate: async () => assert.fail('No navigation during registration'),
    action: async () => assert.fail('No action during registration'), snapshot: async () => ({}) };
  for (const [request, quantity, name] of [
    ['ten chocolate timbits', 10, 'chocolate timbits'],
    ['10 chocolate Timbits', 10, 'chocolate Timbits'],
    ['10 chocolate glazed timbits', 10, 'chocolate glazed timbits'],
    ['twenty chocolate Timbits', 20, 'chocolate Timbits'],
    ['a 10-pack chocolate Timbits', 10, '10-pack chocolate Timbits'],
    ['one 10-pack of chocolate Timbits', 10, '10-pack chocolate Timbits'],
    ['ten-pack chocolate Timbits', 10, '10-pack chocolate Timbits'],
  ]) {
    const result = beginOperatorWebOrder({ branchAddress: '100 Sample St', items: [request], profileDriver: driver });
    try {
      assert.equal(result.status, 'awaiting_operator');
      assert.equal(result.items[0].quantity, quantity); assert.equal(result.items[0].name, name);
      assert.equal(result.items[0].requested_units, quantity);
      if (/pack/.test(request)) assert.equal(result.items[0].cart_quantity_requested, 1);
    } finally { await cancelWebOrder(result.job_id); }
  }
  const units = { request: 'chocolate Timbits', quantity: 10 };
  assert.deepEqual(browserOrderGuards.cartQuantity(units, '10 Timbits Pack', 'Quantity 1'),
    { cart_quantity: 1, requested_units: 10, package_size: 10 });
  assert.equal(browserOrderGuards.cartQuantity(units, '20 Timbits Pack', 'Quantity 1'), null);
  assert.equal(browserOrderGuards.cartQuantity(units, '10 Timbits Pack', 'Quantity 10'), null);
  assert.equal(browserOrderGuards.cartQuantity(units, 'Timbits', 'Quantity 1'), null);
  assert.equal(browserOrderGuards.cartQuantity(units, 'Chocolate Glazed Timbits', 'Quantity 9'), null);
  assert.equal(browserOrderGuards.matchesRequestedItem(units.request, ['10 Assorted Timbits Pack']), false);
  assert.equal(browserOrderGuards.matchesRequestedItem(units.request, ['10 Assorted Timbits Pack', 'Chocolate Glazed'], false, 10), false);
  assert.equal(browserOrderGuards.matchesRequestedItem(units.request, ['10 Assorted Timbits Pack', 'All Chocolate Glazed'], false, 10), true);
  assert.equal(browserOrderGuards.matchesRequestedItem(units.request, ['10 Assorted Timbits Pack', '10 Chocolate Glazed'], false, 10), true);
  assert.equal(browserOrderGuards.matchesRequestedItem(units.request, ['10 Assorted Timbits Pack', '9 Chocolate Glazed'], false, 10), false);
});

test('fifty and larger spoken Timbits counts preserve units and verify the actual boxed menu title', async () => {
  const driver = { navigate: async () => assert.fail('No navigation'), action: async () => assert.fail('No action'), snapshot: async () => ({}) };
  for (const phrase of ['50 timbits', 'fifty timbits', 'one fifty pack', 'one50pack', '50AssortedTimbits']) {
    const result = beginOperatorWebOrder({ branchAddress: '100 Sample St', items: [phrase], profileDriver: driver });
    try {
      assert.equal(result.status, 'awaiting_operator', phrase);
      assert.equal(result.items[0].quantity, 50, phrase); assert.equal(result.items[0].requested_units, 50, phrase);
      if (/pack/.test(phrase)) assert.equal(result.items[0].cart_quantity_requested, 1);
      assert.equal(browserOrderGuards.matchesRequestedItem(result.items[0].request, ['50AssortedTimbits'], false, 50), true);
      assert.deepEqual(browserOrderGuards.cartQuantity(result.items[0], '50 Assorted Timbits', 'Quantity 1'),
        { cart_quantity: 1, requested_units: 50, package_size: 50 });
      assert.equal(browserOrderGuards.cartQuantity(result.items[0], '50AssortedTimbits', 'Quantity 50'), null);
    } finally { await cancelWebOrder(result.job_id); }
  }
  for (const [phrase, count] of [['thirty timbits', 30], ['forty timbits', 40], ['fifty-one timbits', 51], ['one hundred timbits', 100]]) {
    const result = beginOperatorWebOrder({ branchAddress: '100 Sample St', items: [phrase], profileDriver: driver });
    try { assert.equal(result.status, 'awaiting_operator'); assert.equal(result.items[0].quantity, count); }
    finally { await cancelWebOrder(result.job_id); }
  }
  const over = beginOperatorWebOrder({ branchAddress: '100 Sample St', items: ['101 timbits'], profileDriver: driver });
  assert.equal(over.status, 'waiting_user');
});

test('delivery cart review verifies destination and quantities without inventing a source restaurant', async () => {
  const address = '570 Dunsmuir St Vancouver BC V6B1Y1 Alexander College AIC Founders Lab';
  const modeQuote = 'Delivery 570 Dunsmuir Street';
  const addressQuote = '570 Dunsmuir Street Vancouver BC V6B 1Y1';
  const instructions = 'Alexander College AIC Founders Lab';
  let actualAddress = addressQuote;
  const driver = { navigate: async () => assert.fail('Operator review must not navigate'),
    action: async () => assert.fail('Operator review must not act'), snapshot: async step => ({
      url: 'https://www.timhortons.ca/checkout', revision: `delivery-fixture-${step}`, pickupAreas: [modeQuote],
      controls: [{ id: 1, label: '1 Cart', tag: 'button' }],
      visibleText: `Your order ${modeQuote} ${actualAddress} ${instructions} 10 Timbits Pack Quantity 1 Chocolate $3.99 Total $9.35`,
    }) };
  const started = beginOperatorWebOrder({ branchAddress: address, serviceMode: 'delivery', deliveryAddress: address,
    deliveryAddressConfirmed: true, items: ['ten chocolate timbits'], profileDriver: driver });
  const evidence = { selected_service_mode_quote: modeQuote, delivery_address_quote: addressQuote,
    delivery_instructions_quote: instructions, cart_items: [{ request_index: 0, name_quote: '10 Timbits Pack',
      quantity_quote: 'Quantity 1', customization_quotes: ['Chocolate'], price_quote: '$3.99' }], total_quote: 'Total $9.35' };
  try {
    const reviewed = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence });
    assert.equal(reviewed.status, 'cart_ready'); assert.equal(reviewed.delivery.verified, true);
    assert.equal(reviewed.branch.verified, false); assert.equal(reviewed.branch.restaurant_unknown, true);
    assert.equal(reviewed.branch.requested_address, null); assert.equal(reviewed.merchant.verified_website, true);
    assert.equal(reviewed.items[0].requested_units, 10); assert.equal(reviewed.items[0].cart_quantity, 1);
    assert.equal(reviewed.total_cad, 9.35); assert.equal(reviewed.order_submitted, false);
    actualAddress = addressQuote.replace('570', '580');
    const changed = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence });
    assert.equal(changed.status, 'needs_review'); assert.equal(changed.order_submitted, false);
  } finally { await cancelWebOrder(started.job_id); }
});

test('direct-Cua approval validates fresh Edit proof, grants one attempt, and requires an actual receipt without clicking', async () => {
  const previousFetch = globalThis.fetch, quote = 'Pick Up 650 W Georgia St';
  let phase = 'edit', actions = 0, cartTotal = 'Total $2.51';
  const evidence = { selected_service_mode_quote: quote, cart_items: [{ request_index: 0,
    name_quote: 'Brewed Coffee', quantity_quote: 'Quantity 1', customization_quotes: ['Medium', '2 Cream', '2 Sugar'], price_quote: '$2.39' }],
    total_quote: 'Total $2.51', payment_quote: 'Payment method: Tims Gift Card',
    balance_quote: 'Tims Gift Card balance $15.00', final_target_id: '3' };
  const driver = { navigate: async () => { actions++; }, action: async () => { actions++; },
    snapshot: async step => ({ url: 'https://www.timhortons.ca/checkout', revision: `cua-fixture-${step}`, pickupAreas: [quote],
      visibleText: phase === 'edit' ? `${quote} Brewed Coffee Size Medium Double Double Dairy & Alternatives 2 Cream Sweeteners 2 Sugar Update 1 Brewed Coffee for $2.39`
        : phase === 'receipt' ? 'Order confirmed Order number CA1234'
          : `Your order ${quote} Brewed Coffee Quantity 1 Medium 2 Cream 2 Sugar $2.39 ${cartTotal} Payment method: Tims Gift Card Tims Gift Card balance $15.00 Place Order`,
      controls: phase === 'edit' ? [{ id: 1, label: 'Double Double', checked: true, tag: 'input' },
        { id: 2, label: 'Size Medium', tag: 'button' }, { id: 3, label: 'Update 1 Brewed Coffee for $2.39', tag: 'button' }]
        : phase === 'receipt' ? [] : [{ id: 1, label: '1 Cart', tag: 'button' },
          { id: 2, label: 'Tims Gift Card', checked: true, tag: 'input' }, { id: 3, label: 'Place Order', tag: 'button' }] }) };
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(evidence) } }] }), { status: 200 });
  const started = beginOperatorWebOrder({ branchAddress: '650 W Georgia St', items: ['one Medium Double Double Brewed Coffee'],
    profileDriver: driver, config: { OPENROUTER_API_KEY: 'offline-fixture' } });
  try {
    const selected = await registerOperatorSelection(started.job_id, { requestIndex: 0 });
    assert.equal(selected.recorded, true); assert.equal(selected.selection_evidence[0].kind, 'operator_checked_choice_before_update');
    assert.equal(selected.selection_evidence[0].size_quote, 'Size Medium');
    phase = 'cart';
    const prepared = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence });
    assert.equal(prepared.status, 'cart_ready');
    const automatic = await submitApprovedWebOrder(started.job_id, { approvedTotal: 2.51, budgetCad: 100 });
    assert.equal(automatic.status, 'needs_review');
    const authorized = await verifyOperatorSubmissionApproval(started.job_id, { approvedTotal: 2.51, budgetCad: 100 });
    assert.equal(authorized.status, 'awaiting_operator_submission'); assert.equal(authorized.purchase_attempted, false);
    assert.equal(authorized.submission_allowed, false); assert.equal(authorized.final_control_quote, 'Place Order');
    cartTotal = 'Total $2.52';
    const changed = await startOperatorSubmission(started.job_id);
    assert.equal(changed.status, 'needs_review'); assert.equal(changed.purchase_attempted, false);
    cartTotal = 'Total $2.51';
    await verifyOperatorSubmissionApproval(started.job_id, { approvedTotal: 2.51, budgetCad: 100 });
    const first = await startOperatorSubmission(started.job_id);
    assert.equal(first.status, 'operator_submission_started'); assert.equal(first.submission_allowed, true);
    const second = await startOperatorSubmission(started.job_id);
    assert.equal(second.submission_allowed, false); assert.equal(second.status, 'needs_takeover');
    const unsupported = await registerOperatorReceipt(started.job_id, { receiptEvidence: {
      confirmation_quote: 'Order confirmed', order_number_quote: 'Order number CA1234' } });
    assert.equal(unsupported.order_submitted, false);
    phase = 'receipt';
    const confirmed = await registerOperatorReceipt(started.job_id, { receiptEvidence: {
      confirmation_quote: 'Order confirmed', order_number_quote: 'Order number CA1234' } });
    assert.equal(confirmed.status, 'ordered'); assert.equal(confirmed.confirmation.order_number, 'CA1234');
    assert.equal(actions, 0, 'Operator APIs only read metadata and never click, navigate, or wait through the browser');
  } finally { globalThis.fetch = previousFetch; await cancelWebOrder(started.job_id); }
});
