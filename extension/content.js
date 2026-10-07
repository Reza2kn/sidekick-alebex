'use strict';

(() => {
  const BRIDGE_VERSION = '2026-10-07-delivery-evidence-3';
  if (globalThis.__sidekickTimBridgeInstalled === BRIDGE_VERSION) return;
  globalThis.__sidekickTimBridgeInstalled = BRIDGE_VERSION;
  const HOSTS = new Set(['www.timhortons.ca', 'timhortons.ca']);
  const SENSITIVE = /password|user.?name|e-?mail|phone|\btel\b|credit|cc[-_]|card.?number|cvv|cvc|\bpin\b|payment|billing|security.?code|one.?time|otp|verification.?code/i;
  const LOGIN = /\b(?:sign\s*in|log\s*in|register|create\s+account)\b/i;
  const PURCHASE = /\b(?:pay(?:ment)?|place\s+(?:(?:my|delivery|pickup|secure)\s+)?order|submit\s+(?:order|purchase)|complete\s+(?:order|purchase)|confirm\s+(?:order|purchase)|buy\s+now|purchase)\b/i;
  const FINAL = /^(?:place|submit|confirm|complete)\s+(?:(?:my|delivery|pickup|secure)\s+)?order(?:\s+(?:for\s+)?(?:CA\$|C\$|\$)\s*\d+(?:\.\d{2})?)?$/i;
  let revision = '', targets = new Map(), revisionAt = 0, purchaseAttempted = false;
  const clean = (value, max = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const scrub = value => String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email hidden]')
    .replace(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone hidden]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card number hidden]')
    .replace(/\b(?:hi|hello|welcome back),?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g, '[account greeting hidden]');
  const visible = node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none'; };
  const rendered = node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const allowed = value => { try { const url = new URL(value, location.href); return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443'); } catch { return false; } };
  const privateNode = node => Boolean(node.closest('input,textarea,[data-testid*="account"],[data-testid*="profile"],[data-testid*="user-name"],[class*="account-name"],[class*="profile-name"]'));
  const label = node => {
    const associated = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null;
    const referenced = (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).map(id => { const referencedNode = document.getElementById(id); return referencedNode?.innerText || referencedNode?.textContent || ''; }).filter(Boolean).join(' ');
    return clean(scrub(node.getAttribute('aria-label') || referenced || associated?.innerText || node.innerText || node.getAttribute('placeholder') || node.getAttribute('title') || node.name));
  };
  const sensitive = node => /^(password|email|tel)$/i.test(node.type || '') || (/^(INPUT|TEXTAREA)$/.test(node.tagName) && !/^(radio|checkbox|button|submit)$/.test(node.type || '') && SENSITIVE.test([node.type, node.name, node.id, node.autocomplete, label(node)].join(' ')));
  const signature = node => JSON.stringify([label(node), node.getAttribute('href'), node.type, Boolean(node.disabled), node.getAttribute('aria-disabled')]);
  function refuse(message, code = 'refused') { const error = new Error(message); error.code = code; throw error; }
  function pageText() {
    const parts = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || privateNode(parent) || parent.closest('script,style,noscript') || !rendered(parent)) continue;
      const value = clean(scrub(node.nodeValue), 1000); if (value) parts.push(value);
    }
    // Delivery drop-off text is a visible editable value, not a text node.
    // Include only this nonprivate field; contact/payment inputs stay hidden.
    for (const input of document.querySelectorAll('input,textarea')) {
      if (!rendered(input) || sensitive(input) || !/delivery instructions/i.test(label(input))) continue;
      const value = clean(scrub(input.value), 500);
      if (value) parts.push(label(input), value);
    }
    const joined = parts.join('\n');
    return joined.length > 12000 ? joined.slice(0, 7999) + '\n' + joined.slice(-4000) : joined;
  }
  function snapshot(params) {
    if (!allowed(location.href)) refuse('Only official Canadian Tim Hortons pages are permitted.');
    for (const node of document.querySelectorAll('[data-sidekick-target]')) node.removeAttribute('data-sidekick-target');
    revision = `${Number.isSafeInteger(params.step) ? params.step : 0}-${crypto.randomUUID()}`; revisionAt = Date.now(); targets = new Map();
    const controls = [], pickupAreas = [];
    const nodes = [...document.querySelectorAll('button,a,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="radio"],[role="checkbox"]')];
    const priority = node => /pick\s*up|pickup/i.test(label(node)) ? 0 : node.closest('[role="dialog"],dialog') ? 1 : /^(INPUT|TEXTAREA)$/.test(node.tagName) ? 2 : 3;
    nodes.sort((a, b) => priority(a) - priority(b));
    for (const node of nodes) {
      if (!visible(node) || controls.length >= 140) continue;
      const privateInput = sensitive(node), value = label(node), context = privateInput ? '[private input]' : clean(scrub(node.parentElement?.innerText), 360);
      let branchCardContext = '';
      if (!privateInput) for (let ancestor = node.parentElement, depth = 0; ancestor && depth < 4; ancestor = ancestor.parentElement, depth++) {
        const candidate = clean(scrub(ancestor.innerText), 800);
        if (candidate.length < 800 && /\d+\s+[^\n]*(?:street|st\b|avenue|ave\b|road|rd\b)/i.test(candidate)) { branchCardContext = candidate; break; }
      }
      const id = controls.length + 1;
      node.setAttribute('data-sidekick-target', `${revision}:${id}`); targets.set(id, { node, signature: signature(node) });
      const rawHref = node.getAttribute('href');
      let href = null; if (rawHref) { try { const url = new URL(rawHref, location.href); href = `${url.origin}${url.pathname}`; } catch {} }
      const control = { id, role: node.getAttribute('role') || node.tagName.toLowerCase(), tag: node.tagName.toLowerCase(), label: privateInput ? '[private input]' : value, context,
        input_type: node.type || null, input_name: privateInput ? '[private input]' : clean(node.name || node.id, 100), href,
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'), checked: Boolean(node.checked || node.getAttribute('aria-checked') === 'true'), sensitive: privateInput,
        ...(branchCardContext ? { branch_card_context: branchCardContext } : {}) };
      if (node.tagName === 'SELECT') control.options = [...node.options].map(option => ({ label: clean(scrub(option.text)), selected: option.selected })).slice(0, 12);
      controls.push(control);
      if (/pick\s*up|pickup|delivery|selected (?:restaurant|store)|ordering (?:at|from)/i.test(value)) { pickupAreas.push(value, context); }
    }
    for (const node of document.querySelectorAll('button,a,[role="button"],[role="link"],footer,p,h1,h2,h3,h4,section,div')) {
      if (!rendered(node) || privateNode(node)) continue;
      const value = clean(scrub(node.innerText), 360);
      if (value && /^(?:pick\s*up|pickup|delivery|selected (?:restaurant|store)|ordering (?:at|from))\b/i.test(value)) pickupAreas.push(value);
    }
    const url = new URL(location.href);
    return { bridge_version: BRIDGE_VERSION, revision, url: `${url.origin}${url.pathname}`, captured_at: new Date().toISOString(), title: clean(scrub(document.title), 120), visibleText: pageText(), controls, pickupAreas: [...new Set(pickupAreas.filter(Boolean))].slice(0, 60) };
  }
  async function action(params) {
    if (!allowed(location.href)) refuse('The tab left the permitted Tim Hortons website.');
    if (!revision || params.revision !== revision || Date.now() - revisionAt > 30000) refuse('Take a fresh snapshot before acting.', 'stale_revision');
    if (!['click', 'fill', 'scroll', 'wait'].includes(params.action)) refuse('Unsupported fixed page action.');
    if (params.action === 'scroll') { revision = ''; window.scrollBy({ top: params.direction === 'up' ? -620 : 620, behavior: 'instant' }); await new Promise(resolve => setTimeout(resolve, 150)); return { performed: 'scroll' }; }
    if (params.action === 'wait') { revision = ''; await new Promise(resolve => setTimeout(resolve, 800)); return { performed: 'wait' }; }
    if (!Number.isInteger(params.target_id)) refuse('Use a numbered target from the fresh snapshot.');
    const record = targets.get(params.target_id), node = record?.node;
    if (!node?.isConnected || !visible(node) || node.getAttribute('data-sidekick-target') !== `${revision}:${params.target_id}` || signature(node) !== record.signature) refuse('The selected control changed. Take a fresh snapshot.', 'stale_revision');
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') refuse('That control is disabled.');
    if (sensitive(node) || LOGIN.test(label(node))) refuse('Sign-in, contact details, verification, and payment inputs require private human control.');
    const href = node.getAttribute('href'); if (href && !allowed(href)) refuse('Links outside the official Tim Hortons website are refused.');
    const targetLabel = label(node);
    const finalClick = params.action === 'click' && params.submit === true && FINAL.test(targetLabel);
    if (params.submit === true && !finalClick) refuse('Approved-submit is restricted to an exact final order button.');
    if (params.action === 'click' && PURCHASE.test(targetLabel) && !finalClick) refuse('A final purchase requires the trusted server’s explicit approved-submit command.');
    if (finalClick) {
      if (purchaseAttempted) refuse('The final order was already attempted. Please check its receipt privately.', 'purchase_already_attempted');
      if (typeof params.approvedTotal !== 'number' || !Number.isFinite(params.approvedTotal) || params.approvedTotal <= 0 || params.approvedTotal > 100) refuse('The trusted approval total is missing.');
      const totals = [...pageText().matchAll(/\b(?:order\s+)?total(?:\s*\([^)]{0,45}\))?\s*[:\s]*(?:CA\$|C\$|CAD\s*\$?|\$)\s*(\d{1,3}(?:,\d{3})*\.\d{2})/gi)].map(match => Math.round(Number(match[1].replaceAll(',', '')) * 100));
      const distinct = [...new Set(totals)];
      if (distinct.length !== 1 || distinct[0] !== Math.round(params.approvedTotal * 100)) refuse('The currently rendered all-in total does not uniquely match your approved total.');
    }
    if (params.action === 'fill') {
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || /^(file|hidden|submit|button|radio|checkbox|password|email|tel)$/i.test(node.type || '')) refuse('This control cannot be filled.');
      if (typeof params.value !== 'string' || params.value.length > 500 || scrub(params.value) !== params.value || SENSITIVE.test([node.name, node.id, node.autocomplete, targetLabel].join(' '))) refuse('This input is private or the supplied value is invalid.');
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) refuse('The control cannot be edited.');
      setter.call(node, params.value); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    } else { if (finalClick) purchaseAttempted = true; node.click(); }
    revision = ''; await new Promise(resolve => setTimeout(resolve, 150));
    return { performed: params.action, target_id: params.target_id, purchase_attempted: finalClick };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'sidekick.profile.rpc') return;
    Promise.resolve().then(() => {
      if (message.method === 'snapshot') return snapshot(message.params || {});
      if (message.method === 'action') return action(message.params || {});
      refuse('Unsupported fixed content command.');
    }).then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: { code: error.code || 'failed', message: String(error.message).slice(0, 300) } }));
    return true;
  });
})();
