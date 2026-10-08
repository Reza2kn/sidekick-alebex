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

test('official payment pages can be read without authorizing navigation, private input, or purchase controls', () => {
  const { readablePageUrl, allowedUrl, isBlockedControl } = browserOrderGuards;
  assert.equal(readablePageUrl('https://www.timhortons.ca/cart/payment'), true);
  assert.equal(readablePageUrl('https://timhortons.ca/cart/payment'), true);
  assert.equal(allowedUrl('https://www.timhortons.ca/cart/payment'), false, 'Reading must not relax the existing navigation gate');
  assert.equal(allowedUrl('https://www.timhortons.ca/login'), false);
  for (const url of ['https://example.com/cart/payment', 'https://timhortons.ca.example.com/cart/payment',
    'http://www.timhortons.ca/cart/payment', 'https://user:pass@www.timhortons.ca/cart/payment',
    'https://www.timhortons.ca:8443/cart/payment']) {
    assert.equal(readablePageUrl(url), false, url);
    assert.equal(allowedUrl(url), false, url);
  }
  for (const label of ['Place Delivery order for $15.98', 'Place Pickup Order', 'Place Secure Order', 'Payment', 'Sign In']) {
    assert.equal(isBlockedControl(label), true, label);
  }
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
  const selected = { label: 'Your selected payment method is Tim card', context: 'Tims Gift Card •••• 5555 - $20.00 Your selected payment method is Tim card' };
  const data = { approvedTotal: 15.98, budgetCad: 100, lockedTotal: 15.98, actualTotal: 15.98,
    paymentQuote: selected.label, balanceQuote: 'Tims Gift Card •••• 5555 - $20.00',
    selectedPaymentControls: [selected], finalControlLabel: 'Place Delivery order for $15.98',
    visibleText: `${selected.context} Total $15.98` };
  const check = browserOrderGuards.validateApprovalEvidence;
  assert.equal(check(data).allowed, true);
  assert.equal(check({ ...data, selectedPaymentControls: [] }).allowed, false, 'Header card amount alone cannot prove its selected payment balance');
  assert.equal(check({ ...data, selectedPaymentControls: [{ ...selected, context: 'MASTERCARD •••• 4481 exp. 07/29' }] }).allowed, false, 'Stale Tim-card aria label cannot override the displayed credit card');
  assert.equal(check({ ...data, balanceQuote: 'Tims Gift Card balance $20.00', selectedPaymentControls: [{ ...selected, context: 'MASTERCARD •••• 4481 exp. 07/29' }], visibleText: `${selected.label} Tims Gift Card balance $20.00 Total $15.98` }).allowed, false, 'An explicitly labelled header balance cannot override the actual selected credit card');
  assert.equal(check({ ...data, finalControlLabel: 'Place Delivery order for $18.14' }).allowed, false);
  assert.equal(check({ ...data, balanceQuote: 'Tims Gift Card •••• 5555 - $10.00', selectedPaymentControls: [{ ...selected, context: selected.context.replace('$20.00', '$10.00') }], visibleText: selected.context.replace('$20.00', '$10.00') }).allowed, false);
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

test('delivery cart review verifies the selected merchant, destination and quantities separately', async () => {
  const address = '570 Dunsmuir St Vancouver BC V6B1Y1 Alexander College AIC Founders Lab';
  const modeQuote = 'Delivery 570 Dunsmuir Street';
  const addressQuote = '570 Dunsmuir Street Vancouver BC V6B 1Y1';
  const instructions = 'Alexander College AIC Founders Lab';
  const merchantQuote = 'Selected restaurant Tim Hortons 607 Dunsmuir Street';
  let actualAddress = addressQuote;
  const driver = { navigate: async () => assert.fail('Operator review must not navigate'),
    action: async () => assert.fail('Operator review must not act'), snapshot: async step => ({
      url: 'https://www.timhortons.ca/checkout', revision: `delivery-fixture-${step}`, pickupAreas: [modeQuote, merchantQuote],
      controls: [{ id: 1, label: '1 Cart', tag: 'button' }],
      visibleText: `Your order ${merchantQuote} ${modeQuote} ${actualAddress} ${instructions} 10 Timbits Pack Quantity 1 Chocolate $3.99 Total $9.35`,
    }) };
  const started = beginOperatorWebOrder({ branchAddress: '607 Dunsmuir St', serviceMode: 'delivery', deliveryAddress: address,
    deliveryAddressConfirmed: true, items: ['ten chocolate timbits'], profileDriver: driver });
  const evidence = { branch_quote: merchantQuote, selected_service_mode_quote: modeQuote, delivery_address_quote: addressQuote,
    delivery_instructions_quote: instructions, cart_items: [{ request_index: 0, name_quote: '10 Timbits Pack',
      quantity_quote: 'Quantity 1', customization_quotes: ['Chocolate'], price_quote: '$3.99' }], total_quote: 'Total $9.35' };
  try {
    const reviewed = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence });
    assert.equal(reviewed.status, 'cart_ready'); assert.equal(reviewed.delivery.verified, true);
    assert.equal(reviewed.branch.verified, true); assert.equal(reviewed.branch.selected_quote, merchantQuote);
    assert.equal(reviewed.branch.requested_address, '607 Dunsmuir St'); assert.equal(reviewed.merchant.branch_verified, true);
    assert.equal(reviewed.items[0].requested_units, 10); assert.equal(reviewed.items[0].cart_quantity, 1);
    assert.equal(reviewed.total_cad, 9.35); assert.equal(reviewed.order_submitted, false);
    actualAddress = addressQuote.replace('570', '580');
    const changed = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence });
    assert.equal(changed.status, 'needs_review'); assert.equal(changed.order_submitted, false);
  } finally { await cancelWebOrder(started.job_id); }
});

test('delivery cannot review or authorize an unknown or different merchant at the same destination', async () => {
  const previousFetch = globalThis.fetch, branch = '607 Dunsmuir St';
  const address = '570 Dunsmuir St Vancouver BC V6B1Y1 Alexander College AIC Founders Lab';
  const mode = 'Delivery 570 Dunsmuir Street', addressQuote = '570 Dunsmuir Street Vancouver BC V6B 1Y1';
  const instructions = 'Alexander College AIC Founders Lab';
  const correct = 'Preparing at Tim Hortons 607 Dunsmuir Street';
  let merchant = '', actions = 0;
  const evidence = () => ({ branch_quote: merchant || mode, selected_service_mode_quote: mode,
    delivery_address_quote: addressQuote, delivery_instructions_quote: instructions,
    cart_items: [{ request_index: 0, name_quote: '50 Assorted Timbits', quantity_quote: 'Quantity 1', customization_quotes: [], price_quote: '$11.99' }],
    total_quote: 'Total $15.98', payment_quote: 'Payment method: Tims Gift Card', balance_quote: 'Tims Gift Card balance $20.00', final_target_id: 3 });
  const driver = { navigate: async () => { actions++; }, action: async () => { actions++; }, snapshot: async step => ({
    url: 'https://www.timhortons.ca/cart/payment', revision: `merchant-guard-${step}`, pickupAreas: [mode, ...(merchant ? [merchant] : [])],
    visibleText: `Your order ${merchant} ${mode} ${addressQuote} ${instructions} 50 Assorted Timbits Quantity 1 $11.99 Total $15.98 Payment method: Tims Gift Card Tims Gift Card balance $20.00`,
    controls: [{ id: 1, tag: 'button', label: '1 Cart' }, { id: 2, tag: 'input', label: 'Tims Gift Card', checked: true },
      { id: 3, tag: 'button', label: 'Place Delivery order for $15.98' }] }) };
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(evidence()) } }] }), { status: 200 });
  const started = beginOperatorWebOrder({ branchAddress: branch, serviceMode: 'delivery', deliveryAddress: address,
    deliveryAddressConfirmed: true, items: ['one fifty pack Timbits'], profileDriver: driver, config: { OPENROUTER_API_KEY: 'offline-fixture' } });
  try {
    for (const quote of ['', 'Delivering from Tim Hortons 108 West Pender Street', 'Requested restaurant 607 Dunsmuir Street']) {
      merchant = quote;
      const blocked = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence() });
      assert.equal(blocked.status, 'needs_review'); assert.equal(blocked.branch.verified, false);
      assert.equal(blocked.delivery.verified, true, 'A verified destination cannot stand in for merchant proof');
      assert.equal(blocked.order_submitted, false);
      assert.match(blocked.blocking_reason, /^delivery_merchant_(unknown|mismatch)$/);
    }
    merchant = correct;
    const prepared = await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence() });
    assert.equal(prepared.status, 'cart_ready'); assert.equal(prepared.branch.verified, true);
    merchant = 'Delivering from Tim Hortons 108 West Pender Street';
    const rejected = await verifyOperatorSubmissionApproval(started.job_id, { approvedTotal: 15.98, budgetCad: 100 });
    assert.equal(rejected.status, 'needs_review'); assert.equal(rejected.purchase_attempted, false);
    assert.equal(rejected.branch.verified, false); assert.equal(rejected.blocking_reason, 'delivery_merchant_mismatch');
    assert.equal(rejected.total_cad, null, 'A rejected merchant cannot retain an apparently approvable total');
    merchant = correct;
    await registerOperatorPreparedCart({ jobId: started.job_id, reviewEvidence: evidence() });
    const authorized = await verifyOperatorSubmissionApproval(started.job_id, { approvedTotal: 15.98, budgetCad: 100 });
    assert.equal(authorized.status, 'awaiting_operator_submission');
    merchant = '';
    const changed = await startOperatorSubmission(started.job_id);
    assert.equal(changed.status, 'needs_review'); assert.equal(changed.purchase_attempted, false);
    assert.equal(changed.branch.verified, false); assert.equal(changed.blocking_reason, 'delivery_merchant_unknown');
    assert.notEqual(changed.submission_allowed, true); assert.equal(actions, 0);
  } finally { globalThis.fetch = previousFetch; await cancelWebOrder(started.job_id); }
});

test('direct-Cua approval on cart/payment validates fresh Edit proof, grants one attempt, and requires an actual receipt without clicking', async () => {
  const previousFetch = globalThis.fetch, quote = 'Pick Up 650 W Georgia St';
  let phase = 'edit', actions = 0, cartTotal = 'Total $2.51';
  const evidence = { selected_service_mode_quote: quote, cart_items: [{ request_index: 0,
    name_quote: 'Brewed Coffee', quantity_quote: 'Quantity 1', customization_quotes: ['Medium', '2 Cream', '2 Sugar'], price_quote: '$2.39' }],
    total_quote: 'Total $2.51', payment_quote: 'Payment method: Tims Gift Card',
    balance_quote: 'Tims Gift Card balance $15.00', final_target_id: '3' };
  const driver = { navigate: async () => { actions++; }, action: async () => { actions++; },
    snapshot: async step => ({ url: phase === 'edit' ? 'https://www.timhortons.ca/menu' : 'https://www.timhortons.ca/cart/payment', revision: `cua-fixture-${step}`, pickupAreas: [quote],
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

test('OpenAI prepares the current connected cart and checkout while final submission stays with the operator', async () => {
  const previousFetch = globalThis.fetch, address = '570 Dunsmuir St Vancouver BC V6B1Y1 Alexander College AIC Founders Lab';
  const mode = 'Delivery 570 Dunsmuir Street', fullAddress = '570 Dunsmuir Street Vancouver BC V6B 1Y1';
  const instructions = 'Alexander College AIC Founders Lab';
  const merchantQuote = 'Delivering from Tim Hortons 650 W Georgia Street';
  const payment = { id: 2, tag: 'button', label: 'Your selected payment method is Tim card',
    context: 'Tims Gift Card •••• 5555 - $20.00 Your selected payment method is Tim card' };
  const evidence = { action: 'review', branch_quote: merchantQuote, selected_service_mode_quote: mode, delivery_address_quote: fullAddress,
    delivery_instructions_quote: instructions, cart_items: [{ request_index: 0, name_quote: '50 Assorted Timbits',
      quantity_quote: 'Quantity 1', customization_quotes: [], price_quote: '$11.99' }],
    total_quote: 'Total $15.98', payment_quote: payment.label, balance_quote: 'Tims Gift Card •••• 5555 - $20.00', final_target_id: 3 };
  let checkout = false, calls = 0; const actions = [];
  const driver = { navigate: async () => assert.fail('Existing cart must not be navigated or reloaded'),
    action: async action => { if (action.action === 'wait') return; actions.push(action); assert.equal(action.action, 'click'); assert.equal(action.target_id, 1); checkout = true; },
    snapshot: async step => ({ url: checkout ? 'https://www.timhortons.ca/cart/payment' : 'https://www.timhortons.ca/menu',
      revision: `auto-operator-${step}`, pickupAreas: [mode, merchantQuote],
      visibleText: `Your order ${merchantQuote} ${mode} ${fullAddress} ${instructions} 50 Assorted Timbits Quantity 1 $11.99 Total $15.98 ${payment.context}`,
      controls: checkout ? [payment, { id: 3, tag: 'button', label: 'Place Delivery order for $15.98' }]
        : [{ id: 1, tag: 'a', label: 'Checkout', href: 'https://www.timhortons.ca/cart/payment' }] }) };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(JSON.parse(options.body).model, 'gpt-6-luna'); calls++;
    const data = calls === 1 ? { action: 'click', target_id: 1, reason: 'Read checkout total' } : evidence;
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] }), { status: 200 });
  };
  let prepared;
  try {
    prepared = await prepareWebOrder({ branchAddress: '650 W Georgia St', items: ['one fifty pack Timbits'],
      serviceMode: 'delivery', deliveryAddress: address, deliveryAddressConfirmed: true, profileDriver: driver,
      preparationExecutor: 'openai', approvalMode: 'operator', config: { OPENAI_API_KEY: 'offline-fixture' } });
    assert.equal(prepared.status, 'cart_ready', prepared.spoken); assert.equal(prepared.operator_mode, true);
    assert.equal(prepared.preparation_executor, 'openai'); assert.equal(prepared.total_cad, 15.98);
    assert.equal(actions.length, 1); assert.equal(prepared.items[0].requested_units, 50);
    const denied = await submitApprovedWebOrder(prepared.job_id, { approvedTotal: 15.98, budgetCad: 100 });
    assert.equal(denied.status, 'needs_review'); assert.equal(actions.length, 1, 'The automatic submission route cannot click this job');
    const authorized = await verifyOperatorSubmissionApproval(prepared.job_id, { approvedTotal: 15.98, budgetCad: 100 });
    assert.equal(authorized.status, 'awaiting_operator_submission'); assert.equal(authorized.submission_allowed, false);
    assert.equal(actions.length, 1, 'Operator approval must only read the current checkout');
  } finally { globalThis.fetch = previousFetch; if (prepared?.job_id) await cancelWebOrder(prepared.job_id); }
});

test('automatic preparation stops for a private delivery field without guessing or calling a model', async () => {
  const previousFetch = globalThis.fetch; let prepared;
  globalThis.fetch = async () => assert.fail('Private field takeover happens before any provider call');
  const driver = { navigate: async () => assert.fail('Do not reload the existing page'),
    action: async () => assert.fail('Do not enter private fields'), snapshot: async step => ({
      url: 'https://www.timhortons.ca/cart/payment', revision: `private-input-${step}`, pickupAreas: ['Delivery 570 Dunsmuir Street'],
      visibleText: 'Delivery contact phone required', controls: [{ id: 1, tag: 'input', input_type: 'tel', sensitive: true, label: '[private input]' }] }) };
  try {
    prepared = await prepareWebOrder({ branchAddress: '650 W Georgia St', items: ['one fifty pack Timbits'],
      serviceMode: 'delivery', deliveryAddress: '570 Dunsmuir St Vancouver BC', deliveryAddressConfirmed: true,
      profileDriver: driver, preparationExecutor: 'openai', approvalMode: 'operator', config: { OPENAI_API_KEY: 'offline-fixture' } });
    assert.equal(prepared.status, 'needs_takeover'); assert.equal(prepared.operator_mode, true);
    assert.equal(prepared.order_submitted, false); assert.equal(prepared.login_used, false);
  } finally { globalThis.fetch = previousFetch; if (prepared?.job_id) await cancelWebOrder(prepared.job_id); }
});

test('an already paid order receipt cannot become a fresh cart approval', async () => {
  const driver = { navigate: async () => assert.fail('Read only'), action: async () => assert.fail('Read only'),
    snapshot: async step => ({ url: 'https://www.timhortons.ca/order-confirmation/fixture',
      revision: `paid-receipt-${step}`, pickupAreas: [], controls: [],
      visibleText: 'Order Placed Order number 1234 Your Order 50 Assorted Timbits Quantity 1 Total $15.98' }) };
  const task = beginOperatorWebOrder({ branchAddress: '650 W Georgia St', items: ['one fifty pack Timbits'], profileDriver: driver });
  try {
    const result = await registerOperatorPreparedCart({ jobId: task.job_id, reviewEvidence: { cart_items: [] } });
    assert.equal(result.status, 'needs_review');
    assert.match(result.spoken, /completed order receipt/);
    assert.equal(result.order_submitted, false);
  } finally { await cancelWebOrder(task.job_id); }
});

test('automatic delivery Add requires both the selected destination and requested fulfilling merchant', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message',
    content: [{ type: 'output_text', text: JSON.stringify({ action: 'click', target_id: 3, item_index: 0,
      selection_quote: 'Small Black Brewed Coffee', reason: 'Add the requested selected coffee' }) }] }] }), { status: 200 });
  try {
    for (const [correct, merchant, expectedClicks] of [[true, 'Delivering from Tim Hortons 650 W Georgia Street', 1],
      [false, 'Delivering from Tim Hortons 650 W Georgia Street', 0],
      [true, 'Delivering from Tim Hortons 108 West Pender Street', 0], [true, '', 0]]) {
      const mode = `Delivery ${correct ? '570' : '580'} Dunsmuir Street`; const actions = [];
      const driver = { navigate: async () => assert.fail('Do not reload the current page'),
        action: async action => { actions.push(action); }, snapshot: async step => ({ url: 'https://www.timhortons.ca/menu/item',
          revision: `delivery-add-${correct}-${step}`, pickupAreas: [mode, ...(merchant ? [merchant] : [])],
          visibleText: `${merchant} ${mode} Small Black Brewed Coffee Size Small Black 0 Cart Total Add 1 Brewed Coffee to order for $1.92`,
          controls: [{ id: 1, tag: 'input', label: 'Black', checked: true }, { id: 2, tag: 'button', label: 'Size Small' },
            { id: 3, tag: 'button', label: 'Add 1 Brewed Coffee to order for $1.92' }, { id: 4, tag: 'button', label: '0 Cart Total' }] }) };
      const prepared = await prepareWebOrder({ branchAddress: '650 W Georgia St', items: ['one Small Black Brewed Coffee'],
        serviceMode: 'delivery', deliveryAddress: '570 Dunsmuir Street Vancouver BC', deliveryAddressConfirmed: true,
        profileDriver: driver, preparationExecutor: 'openai', approvalMode: 'operator',
        config: { OPENAI_API_KEY: 'offline-fixture', BROWSER_ORDER_MAX_STEPS: 1 } });
      assert.equal(actions.filter(a => a.action === 'click').length, expectedClicks);
      assert.equal(prepared.order_submitted, false);
      await cancelWebOrder(prepared.job_id);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('trusted store routing navigates only an observed empty cart and never reloads an existing cart', async () => {
  const previousFetch = globalThis.fetch;
  const url = 'https://www.timhortons.ca/menu?store-number=105340&service-mode=TAKEOUT&lang=en';
  assert.equal(browserOrderGuards.trustedStoreBootstrapUrl(url, '105340'), url);
  assert.equal(browserOrderGuards.trustedStoreBootstrapUrl(url, '999'), null);
  assert.equal(browserOrderGuards.trustedStoreBootstrapUrl('https://example.com/menu?store-number=105340'), null);
  assert.equal(browserOrderGuards.trustedStoreBootstrapUrl('https://www.timhortons.ca/login?store-number=105340'), null);
  assert.equal(browserOrderGuards.trustedStoreBootstrapUrl(url + '&token=private'), null);
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message',
    content: [{ type: 'output_text', text: JSON.stringify({ action: 'wait', reason: 'Observe selected store' }) }] }] }), { status: 200 });
  try {
    for (const count of [0, 1]) {
      const navigations = [], selected = 'Pick Up 19 Marion Street';
      const driver = { navigate: async target => { navigations.push(target); }, action: async action => assert.equal(action.action, 'wait'),
        snapshot: async step => ({ url: 'https://www.timhortons.ca/menu', revision: `store-bootstrap-${count}-${step}`,
          pickupAreas: [selected], visibleText: `${selected} ${count} Cart Total`, controls: [{ id: 1, tag: 'button', label: `${count} Cart Total` }] }) };
      const result = await prepareWebOrder({ branchAddress: '607 Dunsmuir Street', items: ['one fifty pack Timbits'],
        pickupUrl: url, storeNumber: '105340', profileDriver: driver, preparationExecutor: 'openai', approvalMode: 'operator',
        config: { OPENAI_API_KEY: 'offline-fixture', BROWSER_ORDER_MAX_STEPS: 1 } });
      assert.deepEqual(navigations, count === 0 ? [url] : []);
      assert.equal(result.order_submitted, false); await cancelWebOrder(result.job_id);
    }
  } finally { globalThis.fetch = previousFetch; }
});
