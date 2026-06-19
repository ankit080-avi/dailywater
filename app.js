/* DailyWater — single-page water-delivery manager
   Storage: Supabase (Postgres) with localStorage cache for fast boot + offline tolerance.
   Auth: demo OTP "1234" — real Supabase Auth coming next pass.
*/

(() => {
'use strict';

/* ─── Supabase client ─────────────────────────────────────── */
const SUPABASE_URL = 'https://udclccwehhnhstngvgam.supabase.co';
const SUPABASE_KEY = 'sb_publishable_HDM1tlMFeWoSjJ2pMEBihQ_fCm57d3Z';
let sb = null; // DailyWater's own Supabase project (separate from MilkMate)
try {
  if (window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } }
    });
  }
} catch (e) { console.warn('Supabase init failed', e); }

/* ─── Storage layer ────────────────────────────────────────── */
const Store = {
  KEY: 'dailywater-v1',
  data: null,
  saveTimer: null,
  remoteReady: false,

  // Read cache (sync) — used for fast first paint
  loadFromCache() {
    try {
      const raw = localStorage.getItem(this.KEY);
      this.data = raw ? JSON.parse(raw) : null;
    } catch (e) { this.data = null; }
    if (!this.data) this.data = seed();
    this.migrate();
  },

  // Fetch from Supabase, replace data, return promise.
  // Scoped: owner/customer/boy load only their dairy's data; admin loads everything.
  async loadFromRemote() {
    if (!sb) return false;
    try {
      const oid = currentOwnerId();      // null for admin (or no session yet)
      const isAdmin = App && App.user && App.user.role === 'admin';

      // USERS — always load. Admin sees all; an owner sees themselves + their customers/boys + admin.
      // Other owners and orphan (NULL ownerId) customers/boys are NOT included — they belong to other dairies
      // (or no dairy at all) and would pollute the multi-tenant view.
      const usersQ = sb.from('users').select('*');
      const userScope = oid
        ? usersQ.or('id.eq.' + oid + ',ownerId.eq.' + oid + ',role.eq.admin')
        : usersQ;

      // Helper to scope per-record tables to the current dairy. We intentionally do NOT include
      // ownerId.is.null — orphan rows from before the multi-tenant migration shouldn't bleed into
      // a new owner's view. Admin sees everything (no scope).
      const scoped = (q) => oid && !isAdmin ? q.eq('ownerId', oid) : q;

      const [users, deliveries, pauses, extras, payments, notifs, hols, prods, ratings, dsRes, plansRes, subPaysRes] = await Promise.all([
        userScope,
        scoped(sb.from('deliveries').select('*')),
        scoped(sb.from('pauses').select('*')),
        scoped(sb.from('extra_orders').select('*')),
        scoped(sb.from('payments').select('*')),
        scoped(sb.from('notifications').select('*')),
        scoped(sb.from('holidays').select('*')),
        scoped(sb.from('products').select('*')),
        scoped(sb.from('product_ratings').select('*')),
        oid && !isAdmin
          ? sb.from('dairy_settings').select('*').or('ownerId.eq.' + oid + ',ownerId.eq.u_admin')
          : sb.from('dairy_settings').select('*'),
        // Plans are global (shared catalog); everyone reads them
        sb.from('subscription_plans').select('*'),
        // Subscription payments: admin sees all; owner sees their own; customer/boy: skip
        isAdmin ? sb.from('subscription_payments').select('*')
                : (oid && App.user && App.user.role === 'owner'
                    ? sb.from('subscription_payments').select('*').eq('ownerId', oid)
                    : Promise.resolve({ data: [] }))
      ]);

      // First-run upload: if remote users table is empty AND we have a local owner, push up.
      // After multi-tenant migration this should rarely trigger.
      if ((users.data || []).length === 0 && this.data && this.data.users && this.data.users.length > 0) {
        await this.uploadSnapshot();
        return await this.loadFromRemote();
      }

      // Build per-dairy settings map { ownerId: { ... products, upi, etc. } }
      const dairySettings = {};
      (dsRes.data || []).forEach(row => {
        dairySettings[row.ownerId] = {
          pricePerLitre: Number(row.pricePerLitre) || 60,
          upiId: row.upiId || 'dailywater@upi',
          upiName: row.upiName || 'DailyWater',
          ownerWhatsApp: row.ownerWhatsApp || '',
          businessName: row.businessName || 'My Water Supply',
          businessAddress: row.businessAddress || '',
          businessPhone: row.businessPhone || '',
          products: {}  // products attached below
        };
      });

      // Group products by ownerId into their dairy settings.
      // For legacy rows with NULL ownerId, attribute them to the current owner (oid) so the app keeps
      // working until the SQL migration backfills. They get stamped on next save.
      (prods.data || []).forEach(p => {
        const targetOid = p.ownerId || oid;
        if (!targetOid) return;  // can't attribute — skip (admin sees these listed elsewhere)
        const target = dairySettings[targetOid] || (dairySettings[targetOid] = Object.assign(defaultDairySettings(), { products: {} }));
        target.products[p.key] = {
          name: p.name, price: Number(p.price), emoji: p.emoji || '💧',
          active: p.active !== false, stock: Number(p.stock) || 0
        };
      });

      // Pick the active dairy for this session — default to current user's owner
      const activeDairy = oid && dairySettings[oid] ? dairySettings[oid] : defaultDairySettings();

      this.data = {
        language: activeDairy.language || 'en',
        dairySettings,
        settings: activeDairy,                 // backward-compat: views read Store.data.settings.*
        users: (users.data || []).map(u => ({
          id: u.id, mobile: u.mobile, name: u.name, role: u.role,
          address: u.address || '', dailyMl: u.dailyMl, plan: u.plan,
          frequency: u.frequency || 'daily',
          created_at: u.created_at || null,
          assignedBoyId: u.assignedBoyId, photo: u.photo || null,
          password_hash: u.password_hash || null,
          ownerId: u.ownerId || null,
          status: u.status || (u.role === 'owner' ? 'approved' : null),
          customer_limit: u.customer_limit != null ? Number(u.customer_limit) : (u.role === 'owner' ? 10 : null),
          subscription_plan: u.subscription_plan || null,
          subscription_started_at: u.subscription_started_at || null,
          subscription_expires_at: u.subscription_expires_at || null,
          jars_held: u.jars_held != null ? Number(u.jars_held) : 0,
          jar_deposit: u.jar_deposit != null ? Number(u.jar_deposit) : 0
        })),
        deliveries: (deliveries.data || []).map(d => ({
          id: d.id, customerId: d.customerId, date: d.date, status: d.status,
          ml: d.ml || 0, photo: d.photo || undefined, ownerId: d.ownerId || null
        })),
        pauses: (pauses.data || []).map(p => ({
          id: p.id, customerId: p.customerId, from: p.from, to: p.to, ownerId: p.ownerId || null
        })),
        extraOrders: (extras.data || []).map(o => ({
          id: o.id, customerId: o.customerId, productKey: o.productKey,
          qty: o.qty, date: o.date, status: o.status, ownerId: o.ownerId || null
        })),
        payments: (payments.data || []).map(p => ({
          id: p.id, customerId: p.customerId, month: p.month,
          amount: Number(p.amount), date: p.date, method: p.method, ownerId: p.ownerId || null
        })),
        notifications: (notifs.data || []).map(n => ({
          id: n.id, userId: n.userId, type: n.type, title: n.title,
          body: n.body || '', date: n.date, read: !!n.read, ownerId: n.ownerId || null
        })),
        holidays: (hols.data || []).map(h => ({ date: h.date, label: h.label, ownerId: h.ownerId || null })),
        productRatings: (ratings.data || []).map(r => ({
          id: r.id, customerId: r.customerId, productKey: r.productKey,
          orderId: r.orderId || null, rating: Number(r.rating),
          review: r.review || '', date: r.date || r.created_at, ownerId: r.ownerId || null
        })),
        subscriptionPlans: (plansRes.data || []).map(p => ({
          key: p.key, name: p.name, price: Number(p.price),
          duration_days: Number(p.duration_days), active: p.active !== false,
          sort_order: Number(p.sort_order) || 0
        })),
        subscriptionPayments: (subPaysRes.data || []).map(p => ({
          id: p.id, ownerId: p.ownerId, plan_key: p.plan_key,
          amount_paid: Number(p.amount_paid), paid_at: p.paid_at,
          expires_at: p.expires_at, marked_by_admin_id: p.marked_by_admin_id, note: p.note || ''
        }))
      };
      // Hardening: ensure the software admin user is always present locally even before SQL has been run.
      // Once admin logs in successfully, Store.save() will upsert them to Supabase.
      if (!this.data.users.some(u => u.role === 'admin')) {
        this.data.users.push({
          id: 'u_admin', mobile: '8858141463', name: 'Software Admin',
          role: 'admin', status: 'approved'
        });
      }
      this.cacheLocally();
      this.remoteReady = true;
      return true;
    } catch (e) {
      console.warn('Supabase load failed, using cache', e);
      return false;
    }
  },

  async load() {
    this.loadFromCache(); // fast path
    if (sb) {
      const ok = await this.loadFromRemote();
      if (ok && App && App.user) {
        // Re-render current view if anything was already drawn
        try { navigate(App.route || App.user.role); } catch (e) {}
      }
      this.subscribeRealtime();
    }
  },

  migrate() {
    const s = this.data.settings;
    if (s) {
      if (s.businessName === undefined) s.businessName = 'My Water Supply';
      if (s.businessAddress === undefined) s.businessAddress = '';
      if (s.businessPhone === undefined) s.businessPhone = '';
    } else {
      this.data.settings = defaultDairySettings();
    }
    const prods = this.data.settings && this.data.settings.products;
    if (prods) {
      for (const k in prods) {
        if (prods[k].active === undefined) prods[k].active = true;
        if (prods[k].stock === undefined) prods[k].stock = 0;
      }
    }
    if (!this.data.dairySettings || typeof this.data.dairySettings !== 'object') this.data.dairySettings = {};
    if (!Array.isArray(this.data.holidays)) this.data.holidays = [];
    if (!Array.isArray(this.data.productRatings)) this.data.productRatings = [];
    if (!Array.isArray(this.data.subscriptionPlans) || this.data.subscriptionPlans.length === 0) {
      this.data.subscriptionPlans = defaultSubscriptionPlans();
    }
    if (!Array.isArray(this.data.subscriptionPayments)) this.data.subscriptionPayments = [];
    // Ensure admin user exists in cache
    if (!this.data.users.some(u => u.role === 'admin')) {
      this.data.users.push({ id: 'u_admin', mobile: '8858141463', name: 'Software Admin', role: 'admin', status: 'approved' });
    }
    // Backfill multi-tenant fields for legacy data
    this.data.users.forEach(u => {
      if (u.role === 'owner' && !u.status) u.status = 'approved';
      if (u.role === 'owner' && (u.customer_limit == null || u.customer_limit === undefined)) u.customer_limit = 10;
    });
  },

  cacheLocally() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) {}
  },

  // Sync save: cache locally immediately, push to Supabase in background (debounced)
  save() {
    this.cacheLocally();
    if (!sb) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.uploadSnapshot().catch(e => console.warn('sync failed', e)), 300);
  },

  async uploadSnapshot() {
    if (!sb || !this.data) return;
    const d = this.data;
    const tasks = [];
    const oid = currentOwnerId();
    // Helper: stamp ownerId on a record if it doesn't already have one.
    // For owner/customer/boy actions, oid is set; for admin, records carry their pre-existing ownerId.
    const stamp = (rec, fallback) => Object.assign({}, rec, { ownerId: rec.ownerId || fallback });

    if (d.users.length) tasks.push(sb.from('users').upsert(d.users.map(u => ({
      id: u.id, mobile: u.mobile, name: u.name, role: u.role,
      address: u.address || null, dailyMl: u.dailyMl, plan: u.plan,
      frequency: u.frequency || (u.role === 'customer' ? 'daily' : null),
      assignedBoyId: u.assignedBoyId || null, photo: u.photo || null,
      password_hash: u.password_hash || null,
      ownerId: u.ownerId || null,
      status: u.status || (u.role === 'owner' ? 'approved' : null),
      customer_limit: u.customer_limit != null ? u.customer_limit : (u.role === 'owner' ? 10 : null),
      subscription_plan: u.subscription_plan || null,
      subscription_started_at: u.subscription_started_at || null,
      subscription_expires_at: u.subscription_expires_at || null,
      ...(JARS_ENABLED ? { jars_held: u.jars_held || 0, jar_deposit: u.jar_deposit || 0 } : {})
    }))));

    if (d.deliveries.length) tasks.push(sb.from('deliveries').upsert(d.deliveries.map(x => stamp({
      id: x.id, customerId: x.customerId, date: x.date, status: x.status,
      ml: x.ml || 0, photo: x.photo || null
    }, oid))));
    if (d.pauses.length) tasks.push(sb.from('pauses').upsert(d.pauses.map(p => stamp({
      id: p.id, customerId: p.customerId, from: p.from, to: p.to
    }, oid))));
    if (d.extraOrders.length) tasks.push(sb.from('extra_orders').upsert(d.extraOrders.map(o => stamp({
      id: o.id, customerId: o.customerId, productKey: o.productKey,
      qty: o.qty, date: o.date, status: o.status
    }, oid))));
    if (d.payments.length) tasks.push(sb.from('payments').upsert(d.payments.map(p => stamp({
      id: p.id, customerId: p.customerId, month: p.month,
      amount: p.amount, date: p.date, method: p.method
    }, oid))));
    if (d.notifications.length) tasks.push(sb.from('notifications').upsert(d.notifications.map(n => stamp({
      id: n.id, userId: n.userId, type: n.type, title: n.title,
      body: n.body || null, date: n.date, read: !!n.read
    }, oid))));
    if (d.holidays.length) tasks.push(sb.from('holidays').upsert(d.holidays.map(h => stamp({
      date: h.date, label: h.label
    }, oid)), { onConflict: 'ownerId,date' }));

    // Products: write per-owner. d.settings.products is the active dairy's products.
    if (oid && d.settings && d.settings.products) {
      const productsArr = Object.entries(d.settings.products).map(([key, p]) => ({
        key, name: p.name, price: p.price, emoji: p.emoji || null,
        active: p.active !== false, stock: Number(p.stock) || 0,
        ownerId: oid
      }));
      if (productsArr.length) tasks.push(sb.from('products').upsert(productsArr, { onConflict: 'ownerId,key' }));
    }
    if (d.productRatings && d.productRatings.length) {
      tasks.push(sb.from('product_ratings').upsert(d.productRatings.map(r => stamp({
        id: r.id, customerId: r.customerId, productKey: r.productKey,
        orderId: r.orderId || null, rating: r.rating,
        review: r.review || null, date: r.date
      }, oid))));
    }
    // Per-dairy settings — only write when an owner is logged in (not admin).
    if (oid && d.settings) {
      tasks.push(sb.from('dairy_settings').upsert({
        ownerId: oid,
        pricePerLitre: d.settings.pricePerLitre,
        upiId: d.settings.upiId, upiName: d.settings.upiName,
        ownerWhatsApp: d.settings.ownerWhatsApp,
        businessName: d.settings.businessName,
        businessAddress: d.settings.businessAddress,
        businessPhone: d.settings.businessPhone,
        language: d.language || 'en'
      }, { onConflict: 'ownerId' }));
    }
    // Subscription plans — only admin writes
    if (App.user && App.user.role === 'admin' && d.subscriptionPlans && d.subscriptionPlans.length) {
      tasks.push(sb.from('subscription_plans').upsert(d.subscriptionPlans.map(p => ({
        key: p.key, name: p.name, price: p.price,
        duration_days: p.duration_days, active: p.active !== false,
        sort_order: p.sort_order || 0
      }))));
    }
    // Subscription payments — appended by admin only
    if (App.user && App.user.role === 'admin' && d.subscriptionPayments && d.subscriptionPayments.length) {
      tasks.push(sb.from('subscription_payments').upsert(d.subscriptionPayments.map(p => ({
        id: p.id, ownerId: p.ownerId, plan_key: p.plan_key,
        amount_paid: p.amount_paid, paid_at: p.paid_at,
        expires_at: p.expires_at, marked_by_admin_id: p.marked_by_admin_id,
        note: p.note || null
      }))));
    }
    await Promise.all(tasks);
  },

  // Generic remote-delete: pass a table name and a single id (or array) for the given column.
  // Without this, deletions only happen locally — Supabase upserts re-resurrect them on next sync.
  async removeRemote(table, ids, idCol) {
    if (!sb) return;
    const col = idCol || 'id';
    const list = Array.isArray(ids) ? ids.filter(Boolean) : (ids ? [ids] : []);
    if (list.length === 0) return;
    try {
      await sb.from(table).delete().in(col, list);
    } catch (e) {
      console.warn('remote delete failed', table, e);
    }
  },

  subscribeRealtime() {
    if (!sb || this._channel) return;
    this._channel = sb.channel('mm-realtime')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => {
        clearTimeout(this._refetchTimer);
        this._refetchTimer = setTimeout(() => {
          this.loadFromRemote().then(() => {
            if (App && App.user) {
              try { navigate(App.route || App.user.role); } catch (e) {}
            }
          });
        }, 250);
      })
      .subscribe();
  },

  // Realtime Presence — tracks which users currently have the app open.
  // Owner uses Presence.has(userId) to render the green online dot.
  Presence: {
    online: new Set(),
    channel: null,
    track(user) {
      if (!sb || !user) return;
      this.untrack();
      this.channel = sb.channel('mm-presence', { config: { presence: { key: user.id } } });
      this.channel
        .on('presence', { event: 'sync' }, () => {
          this.online = new Set(Object.keys(this.channel.presenceState() || {}));
          window.dispatchEvent(new CustomEvent('mm-presence-changed'));
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try { await this.channel.track({ id: user.id, role: user.role, name: user.name, ts: Date.now() }); }
            catch (e) { console.warn('presence track failed', e); }
          }
        });
    },
    untrack() {
      const ch = this.channel;
      this.channel = null;
      this.online = new Set();
      if (ch) {
        // Explicitly untrack first so other clients see us leave immediately.
        // Without this the user remains in the presence state until the WebSocket times out.
        Promise.resolve(ch.untrack && ch.untrack())
          .catch(() => {})
          .finally(() => { try { ch.unsubscribe(); } catch (e) {} });
      }
    },
    has(userId) { return this.online.has(userId); }
  },

  reset() {
    localStorage.removeItem(this.KEY);
    this.data = seed();
    this.save();
  }
};

function uid() { return Math.random().toString(36).slice(2, 10); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Multi-tenant helpers — every record is scoped to one owner.
// owner.id IS the dairy id; customers/boys store their owner via user.ownerId.
// Admin has no ownerId — they see all dairies.
function currentOwnerId() {
  const u = App && App.user;
  if (!u) return null;
  if (u.role === 'admin') return null;       // admin: no scope filter (sees all)
  if (u.role === 'owner') return u.id;       // owner: their own id is the dairy id
  return u.ownerId || null;                  // customer / delivery_boy
}
function getAdminUser() { return Store.data.users.find(u => u.role === 'admin'); }
function getOwnerById(id) { return Store.data.users.find(u => u.id === id && u.role === 'owner'); }
function ownerCount(ownerId) {
  return Store.data.users.filter(u => u.ownerId === ownerId && (u.role === 'customer' || u.role === 'delivery_boy')).length;
}
function ownerAtQuota(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) return false;
  return ownerCount(ownerId) >= (Number(owner.customer_limit) || 10);
}

/* ─── Subscription helpers ────────────────────────────────── */
const GRACE_DAYS = 2;          // days after expiry the owner can still log in normally
const FREE_TRIAL_DAYS = 7;     // days granted when admin approves a new owner
const ADMIN_WA_NUMBER = '8858141463';

// Default plan catalog — used as fallback when subscription_plans table is empty.
function defaultSubscriptionPlans() {
  return [
    { key: 'monthly_basic',   name: 'Monthly',   price: 200,  duration_days: 30,  active: true, sort_order: 1 },
    { key: 'quarterly_basic', name: 'Quarterly', price: 500,  duration_days: 90,  active: true, sort_order: 2 },
    { key: 'yearly_basic',    name: 'Yearly',    price: 1500, duration_days: 365, active: true, sort_order: 3 }
  ];
}
function getPlans() {
  const plans = (Store.data && Store.data.subscriptionPlans) || [];
  if (plans.length === 0) return defaultSubscriptionPlans();
  return plans.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}
function getPlanByKey(key) {
  return getPlans().find(p => p.key === key);
}
function daysBetween(future) {
  if (!future) return null;
  const f = new Date(future);
  if (isNaN(f.getTime())) return null;
  const ms = f.getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}
// Subscription state for an owner. Returns one of:
//   'active'     — subscription valid, days >= 0
//   'grace'      — past expiry but within grace window
//   'expired'    — past grace, hard-locked
//   'unlimited'  — no expires_at set (admin-granted permanent or legacy)
function ownerSubscriptionState(ownerOrId) {
  const o = typeof ownerOrId === 'string' ? getOwnerById(ownerOrId) : ownerOrId;
  if (!o) return 'expired';
  if (!o.subscription_expires_at) return 'unlimited';
  const days = daysBetween(o.subscription_expires_at);
  if (days >= 0) return 'active';
  if (days >= -GRACE_DAYS) return 'grace';
  return 'expired';
}
function ownerExpiryInfo(ownerOrId) {
  const o = typeof ownerOrId === 'string' ? getOwnerById(ownerOrId) : ownerOrId;
  if (!o) return { state: 'expired', daysLeft: 0, plan: null };
  const state = ownerSubscriptionState(o);
  const daysLeft = state === 'unlimited' ? null : daysBetween(o.subscription_expires_at);
  return { state, daysLeft, plan: o.subscription_plan || null, expiresAt: o.subscription_expires_at };
}
// Which dairy is the current session bound to? For customer/boy this is their owner.
function activeOwnerForSession() {
  if (!App.user) return null;
  if (App.user.role === 'owner') return App.user;
  if (App.user.role === 'admin') return null;
  return getOwnerById(App.user.ownerId);
}

// Modal shown when an owner tries to add a customer/boy beyond their quota.
// Lets them request more from the software admin (creates an admin notification).
function showQuotaReachedModal(kind) {
  const owner = App.user;
  const limit = Number(owner.customer_limit) || 10;
  const wrap = el('div', {});
  wrap.appendChild(el('div', { style: 'text-align:center;font-size:48px' }, '🚦'));
  wrap.appendChild(el('div', { style: 'text-align:center;font-weight:700;font-size:16px;margin-top:6px' }, 'You\'ve hit your ID limit'));
  wrap.appendChild(el('div', { class: 'text-muted', style: 'text-align:center;font-size:13px;margin:8px 0 14px' },
    'Your quota is ' + limit + ' IDs (customers + delivery boys). To add more, request additional slots from the software admin.'));
  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block',
    onclick: () => {
      const admin = getAdminUser();
      if (admin) notify(admin.id, 'order', 'Quota increase requested',
        owner.name + ' (dairy id ' + owner.id + ') needs more than ' + limit + ' IDs. Tap to grant.');
      toast('Request sent to admin', 'success');
      closeModal();
    }
  }, 'Request more IDs from admin'));
  wrap.appendChild(el('a', {
    class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
    href: waLink('918858141463', 'Hi admin, I\'m ' + owner.name + ' (dairy id ' + owner.id + '). Please grant me more IDs — current limit is ' + limit + '.'),
    target: '_blank', rel: 'noopener'
  }, 'Or WhatsApp admin'));
  wrap.appendChild(el('button', {
    class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
    onclick: () => closeModal()
  }, 'Cancel'));
  openModal('Quota reached', wrap);
}

/* ─── Password hashing (PBKDF2-SHA256, 100k iter, salt = user id) ─ */
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(String(salt || 'dailywater')), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verifyPassword(password, salt, expectedHash) {
  if (!expectedHash) return false;
  const got = await hashPassword(password, salt);
  return got === expectedHash;
}
function fmtMoney(n) { return '₹' + (Math.round(n)).toLocaleString('en-IN'); }
function fmtQty(ml) { return ml >= 1000 ? (ml/1000) + 'L' : ml + 'ml'; }
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }
function prettyDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function prettyMonth(key) {
  const [y, m] = key.split('-');
  return new Date(+y, +m - 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

/* ─── Seed data (3 demo customers + 1 owner + 1 delivery boy) ─ */
function seed() {
  // Multi-tenant SaaS: software admin sells the app to dairy owners ("shopkeepers").
  // Each owner has their own scoped data (customers, products, orders, settings).
  // Admin (8858141463 / OTP 1235) approves new owner signups and grants quota.
  return {
    language: 'en',
    // Per-dairy settings, keyed on ownerId. Populated when an owner is approved.
    dairySettings: {},
    // Fallback settings — used when no owner is logged in (admin views, login screen).
    // Once an owner logs in, Store.data.settings is replaced with dairySettings[ownerId].
    settings: defaultDairySettings(),
    users: [
      { id: 'u_admin', mobile: '8858141463', name: 'Software Admin', role: 'admin', status: 'approved' }
    ],
    deliveries: [],
    pauses: [],
    holidays: [],
    extraOrders: [],
    payments: [],
    notifications: [],
    productRatings: [],
    subscriptionPlans: defaultSubscriptionPlans(),
    subscriptionPayments: []
  };
}

// Default product catalog for a freshly-approved dairy. Owner can customize after.
function defaultDairySettings() {
  return {
    pricePerLitre: 30,
    upiId: 'dailywater@upi',
    upiName: 'DailyWater',
    ownerWhatsApp: '',
    businessName: 'My Water Supply',
    businessAddress: '',
    businessPhone: '',
    products: {
      paneer: { name: '20L Can', price: 110, emoji: '🪣', active: true, stock: 0 },
      curd:   { name: '1L Bottle x12',   price: 50,  emoji: '💧', active: true, stock: 0 },
      butter: { name: '500ml x24', price: 130, emoji: '🚰', active: true, stock: 0 },
      ghee:   { name: 'Dispenser',  price: 480, emoji: '🧴', active: true, stock: 0 }
    }
  };
}

/* ─── i18n: English / Hindi / Marathi (most-visible strings) ─ */
const I18N = {
  en: {
    app_tagline: 'Daily water delivery, made simple for homes and offices.',
    mobile: 'Mobile number', phone_placeholder: '10-digit mobile',
    send_otp: 'Send OTP', enter_otp: 'Enter OTP sent to', verify_continue: 'Verify & Continue',
    change_number: '← Change number', demo_otp_hint: 'Owner OTP: 1234',
    your_name: 'Your name', sign_in_as: 'Sign in as',
    customer: 'Customer', dairy_owner: 'Water Supplier', delivery_boy: 'Delivery Boy',
    delivery_address: 'Delivery address', daily_quantity: 'Daily water quantity',
    create_account: 'Create account',
    enter_password: 'Enter password', set_password: 'Set a password',
    confirm_password: 'Confirm password', password_min: 'Password must be at least 4 characters',
    password_mismatch: 'Passwords do not match', wrong_password: 'Incorrect password',
    set_password_hint: 'Pick a password (min 4 characters). You will use this to log in next time.',
    forgot_password: 'Forgot password?', reset_password: 'Reset password',
    continue_btn: 'Continue', login: 'Login',
    home: 'Home', customers: 'Customers', today: 'Today', bills: 'Bills', reports: 'Reports',
    schedule: 'Schedule', bill: 'Bill', extras: 'Extras', route: 'Route',
    delivered: 'Delivered', skipped: 'Skipped', paused: 'Paused', pending: 'Pending',
    done: 'Done', skip: 'Skip',
    pay_via_upi: 'Pay via UPI', show_qr: 'Show QR to customer', send_whatsapp: 'WhatsApp',
    print_route: 'Print route', amount_due: 'Amount due', total: 'Total',
    welcome_back: 'Welcome back', sign_out: 'Sign out',
    notifications: 'Notifications', mark_all_read: 'Mark all as read',
    order_extras: 'Order extras', order: 'Order', place_order: 'Place order',
    add_photo: 'Add photo proof', view_photo: 'View photo'
  },
  hi: {
    app_tagline: 'दूध की रोज़ाना डिलीवरी — मालिक और ग्राहक दोनों के लिए आसान।',
    mobile: 'मोबाइल नंबर', phone_placeholder: '10 अंकों का मोबाइल',
    send_otp: 'OTP भेजें', enter_otp: 'OTP डालें — भेजा गया है', verify_continue: 'जाँचें और आगे बढ़ें',
    change_number: '← नंबर बदलें', demo_otp_hint: 'मालिक OTP: 1234',
    your_name: 'आपका नाम', sign_in_as: 'किसके रूप में लॉगिन करें',
    customer: 'ग्राहक', dairy_owner: 'डेयरी मालिक', delivery_boy: 'डिलीवरी बॉय',
    delivery_address: 'डिलीवरी पता', daily_quantity: 'रोज़ाना दूध की मात्रा',
    create_account: 'खाता बनाएँ',
    enter_password: 'पासवर्ड डालें', set_password: 'पासवर्ड सेट करें',
    confirm_password: 'पासवर्ड पुष्टि करें', password_min: 'पासवर्ड कम से कम 4 अक्षर',
    password_mismatch: 'पासवर्ड मेल नहीं खाते', wrong_password: 'गलत पासवर्ड',
    set_password_hint: 'पासवर्ड चुनें (कम से कम 4 अक्षर). अगली बार लॉगिन के लिए यही उपयोग होगा.',
    forgot_password: 'पासवर्ड भूल गए?', reset_password: 'पासवर्ड रीसेट',
    continue_btn: 'आगे बढ़ें', login: 'लॉगिन',
    home: 'होम', customers: 'ग्राहक', today: 'आज', bills: 'बिल', reports: 'रिपोर्ट',
    schedule: 'शेड्यूल', bill: 'बिल', extras: 'अतिरिक्त', route: 'रूट',
    delivered: 'डिलीवर हो गया', skipped: 'छोड़ा गया', paused: 'रोका हुआ', pending: 'बाकी',
    done: 'हो गया', skip: 'छोड़ें',
    pay_via_upi: 'UPI से भुगतान', show_qr: 'ग्राहक को QR दिखाएँ', send_whatsapp: 'WhatsApp',
    print_route: 'रूट प्रिंट करें', amount_due: 'बकाया राशि', total: 'कुल',
    welcome_back: 'वापसी पर स्वागत है', sign_out: 'लॉगआउट',
    notifications: 'सूचनाएँ', mark_all_read: 'सब पढ़ा गया मार्क करें',
    order_extras: 'अतिरिक्त ऑर्डर करें', order: 'ऑर्डर', place_order: 'ऑर्डर करें',
    add_photo: 'फोटो जोड़ें', view_photo: 'फोटो देखें'
  },
  mr: {
    app_tagline: 'रोजची दूध डिलिव्हरी — मालक आणि ग्राहक दोघांसाठी सोपी.',
    mobile: 'मोबाइल नंबर', phone_placeholder: '10 अंकी मोबाइल',
    send_otp: 'OTP पाठवा', enter_otp: 'OTP टाका — पाठवला आहे', verify_continue: 'तपासा आणि पुढे जा',
    change_number: '← नंबर बदला', demo_otp_hint: 'मालक OTP: 1234',
    your_name: 'तुमचे नाव', sign_in_as: 'कशा रूपात लॉगिन कराल',
    customer: 'ग्राहक', dairy_owner: 'डेअरी मालक', delivery_boy: 'डिलिव्हरी बॉय',
    delivery_address: 'डिलिव्हरी पत्ता', daily_quantity: 'रोजचे दूध',
    create_account: 'खाते तयार करा',
    enter_password: 'पासवर्ड टाका', set_password: 'पासवर्ड सेट करा',
    confirm_password: 'पासवर्ड पुष्टी करा', password_min: 'पासवर्ड किमान 4 अक्षरे',
    password_mismatch: 'पासवर्ड जुळत नाही', wrong_password: 'चुकीचा पासवर्ड',
    set_password_hint: 'पासवर्ड निवडा (किमान 4 अक्षरे). पुढच्या वेळी लॉगिनसाठी हाच वापरा.',
    forgot_password: 'पासवर्ड विसरलात?', reset_password: 'पासवर्ड रीसेट',
    continue_btn: 'पुढे जा', login: 'लॉगिन',
    home: 'होम', customers: 'ग्राहक', today: 'आज', bills: 'बिल', reports: 'रिपोर्ट',
    schedule: 'वेळापत्रक', bill: 'बिल', extras: 'अतिरिक्त', route: 'रूट',
    delivered: 'पोचवले', skipped: 'सोडले', paused: 'थांबवले', pending: 'बाकी',
    done: 'झाले', skip: 'सोडा',
    pay_via_upi: 'UPI ने पैसे भरा', show_qr: 'ग्राहकाला QR दाखवा', send_whatsapp: 'WhatsApp',
    print_route: 'रूट प्रिंट करा', amount_due: 'थकबाकी', total: 'एकूण',
    welcome_back: 'पुन्हा स्वागत आहे', sign_out: 'लॉगआउट',
    notifications: 'सूचना', mark_all_read: 'सर्व वाचलेले',
    order_extras: 'अतिरिक्त ऑर्डर', order: 'ऑर्डर', place_order: 'ऑर्डर करा',
    add_photo: 'फोटो जोडा', view_photo: 'फोटो पहा'
  }
};
function t(key) {
  const lang = (Store.data && Store.data.language) || 'en';
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}
function setLanguage(lang) {
  Store.data.language = lang;
  Store.save();
  document.documentElement.lang = lang;
}

// Theme: 'light' | 'dark' | 'auto'. Applied via <html data-theme="...">.
let _autoThemeMql = null;
let _autoThemeHandler = null;
function applyTheme(pref) {
  const root = document.documentElement;
  // Tear down any prior auto-mode listener
  if (_autoThemeMql && _autoThemeHandler) {
    _autoThemeMql.removeEventListener('change', _autoThemeHandler);
    _autoThemeMql = null; _autoThemeHandler = null;
  }
  if (pref === 'auto' || !pref) {
    _autoThemeMql = window.matchMedia('(prefers-color-scheme: dark)');
    _autoThemeHandler = () => { root.dataset.theme = _autoThemeMql.matches ? 'dark' : 'light'; };
    _autoThemeMql.addEventListener('change', _autoThemeHandler);
    _autoThemeHandler();
  } else {
    root.dataset.theme = pref;
  }
}
function setTheme(pref) {
  Store.data.theme = pref;
  Store.save();
  applyTheme(pref);
}

/* ─── UPI deep link + QR generation ────────────────────────── */
function upiDeepLink(amount, note) {
  const s = Store.data.settings;
  const params = new URLSearchParams({
    pa: s.upiId, pn: s.upiName,
    am: amount.toFixed(2), cu: 'INR',
    tn: note || 'DailyWater bill'
  });
  return 'upi://pay?' + params.toString();
}

// Admin's UPI (configured via Admin Settings; surfaced on the owner's renewal screen).
function adminUpiSettings() {
  return (Store.data.dairySettings && Store.data.dairySettings['u_admin']) || null;
}
function adminUpiDeepLink(amount, note) {
  const a = adminUpiSettings();
  if (!a || !a.upiId) return null;
  const params = new URLSearchParams({
    pa: a.upiId, pn: a.upiName || 'DailyWater Admin',
    am: Number(amount).toFixed(2), cu: 'INR',
    tn: note || 'DailyWater subscription'
  });
  return 'upi://pay?' + params.toString();
}
function makeQRImage(text) {
  // qrcode-generator library: window.qrcode
  if (typeof window.qrcode !== 'function') return null;
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  const img = new Image();
  img.src = q.createDataURL(6, 4);
  return img;
}

/* ─── WhatsApp deep links ─────────────────────────────────── */
function waLink(mobile, message) {
  const m = String(mobile).replace(/\D/g, '');
  return 'https://wa.me/' + (m.length === 10 ? '91' + m : m) + '?text=' + encodeURIComponent(message);
}
function billWhatsAppMessage(customer, bill, monthLabel) {
  const lines = [
    'Hi ' + customer.name + ', your DailyWater bill for ' + monthLabel + ':',
    '',
    '• Water: ' + fmtQty(bill.totalMl) + ' (' + bill.deliveries + ' days) — ' + fmtMoney(bill.milkAmt),
  ];
  if (bill.extras.length) {
    const products = Store.data.settings.products;
    bill.extras.forEach(o => {
      lines.push('• ' + products[o.productKey].name + ' × ' + o.qty + ' — ' + fmtMoney(products[o.productKey].price * o.qty));
    });
  }
  if (bill.paid > 0) lines.push('• Paid: −' + fmtMoney(bill.paid));
  lines.push('');
  lines.push('Total ' + (bill.due > 0 ? 'due' : '') + ': ' + fmtMoney(bill.due > 0 ? bill.due : bill.total));
  if (bill.due > 0) lines.push('Pay via UPI: ' + Store.data.settings.upiId);
  lines.push('');
  lines.push('Thank you! 💧');
  return lines.join('\n');
}

/* ─── Photo capture (compressed dataURL) ──────────────────── */
function capturePhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = (e) => {
        // Compress via canvas to ~600px max, JPEG quality 0.7
        const img = new Image();
        img.onload = () => {
          const max = 600;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.onerror = () => resolve(null);
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/* ─── App state ────────────────────────────────────────────── */
const App = {
  user: null,
  route: 'login',
  ownerTab: 'home',
  customerTab: 'home',
  boyTab: 'today'
};

function setSession(user) {
  App.user = user;
  if (user) {
    localStorage.setItem('dailywater-session', user.id);
    Store.Presence.track(user);
    // Defer push registration so we don't prompt for notif permission during the
    // login form interaction. Fires after the user has had a moment to land on
    // their dashboard (Permission UX option C — first meaningful event).
    setTimeout(() => Push.register(user), 3000);
  } else {
    localStorage.removeItem('dailywater-session');
    Store.Presence.untrack();
    Push.unregister();
  }
}

// ─── FCM push registration (Capacitor Android + Web) ─────────────────
// Stores tokens in the device_tokens table. The server-side Edge Function
// (built next) reads from there and dispatches pushes when notification
// rows are inserted.
const Push = {
  isCapacitor() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  },
  isConfigured() {
    const c = self.FIREBASE_CONFIG;
    return c && c.apiKey && c.projectId && c.appId;
  },
  // _msg holds the messaging instance for foreground onMessage cleanup
  _msg: null,

  async register(user) {
    if (!user) return;
    if (!this.isConfigured()) {
      console.info('[Push] firebase-config.js not filled in — skipping FCM register.');
      return;
    }
    try {
      if (this.isCapacitor()) {
        await this.registerCapacitor(user);
      } else {
        await this.registerWeb(user);
      }
    } catch (e) {
      console.warn('[Push] register failed', e);
    }
  },

  async registerCapacitor(user) {
    const PN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!PN) {
      console.info('[Push] @capacitor/push-notifications not installed yet — skipping native register.');
      return;
    }
    const perm = await PN.requestPermissions();
    if (perm && perm.receive !== 'granted') return;
    PN.addListener('registration', async (regToken) => {
      await this.saveToken(user.id, regToken.value, 'android');
    });
    PN.addListener('registrationError', (err) => {
      console.warn('[Push] FCM registration error', err);
    });
    // Foreground push on Android — surface as in-app popup
    PN.addListener('pushNotificationReceived', (notif) => {
      try {
        if (typeof showNotificationPopup === 'function') {
          showNotificationPopup('order', notif.title || 'DailyWater', notif.body || '');
        }
      } catch (e) {}
    });
    await PN.register();
  },

  async registerWeb(user) {
    if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      const r = await Notification.requestPermission();
      if (r !== 'granted') return;
    }
    const cfg = self.FIREBASE_CONFIG;
    // Register the FCM service worker (separate from the existing app SW)
    const swReg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    // Dynamically import Firebase modular SDK from the Google CDN
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
    const { getMessaging, getToken, onMessage } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js');
    const app = initializeApp(cfg);
    const messaging = getMessaging(app);
    this._msg = messaging;
    const token = await getToken(messaging, {
      vapidKey: cfg.vapidKey,
      serviceWorkerRegistration: swReg
    });
    if (token) await this.saveToken(user.id, token, 'web');
    // Foreground messages → in-app popup (system notification only fires when app is backgrounded)
    onMessage(messaging, (payload) => {
      const n = (payload && payload.notification) || {};
      try {
        if (typeof showNotificationPopup === 'function') {
          showNotificationPopup('order', n.title || 'DailyWater', n.body || '');
        }
      } catch (e) {}
    });
  },

  async saveToken(userId, token, platform) {
    if (!sb || !token || !userId) return;
    try {
      const id = 'dt_' + userId + '_' + token.slice(0, 24).replace(/[^a-zA-Z0-9]/g, '');
      await sb.from('device_tokens').upsert({
        id, userId, token, platform, updated_at: new Date().toISOString()
      }, { onConflict: 'userId,token' });
      // Remember locally so unregister can find this row to delete
      localStorage.setItem('mm-fcm-token', JSON.stringify({ userId, token }));
    } catch (e) {
      console.warn('[Push] saveToken failed', e);
    }
  },

  async unregister() {
    try {
      const raw = localStorage.getItem('mm-fcm-token');
      if (!raw) return;
      const { userId, token } = JSON.parse(raw) || {};
      if (sb && userId && token) {
        await sb.from('device_tokens')
          .delete()
          .eq('userId', userId)
          .eq('token', token);
      }
    } catch (e) {} finally {
      localStorage.removeItem('mm-fcm-token');
    }
  }
};

// Returns a "● Online" pill that's hidden via CSS when the user is offline.
// Always emit the node so the presence-change handler can toggle visibility live
// without re-rendering the whole page.
function presenceBadge(userId) {
  const isOnline = Store.Presence && Store.Presence.has(userId);
  return el('span', {
    class: 'presence-badge' + (isOnline ? '' : ' is-offline'),
    'data-user-id': userId
  }, [el('span', { class: 'presence-dot' }), 'Online']);
}

// Re-render whenever presence syncs. Updates inline dots AND text pills live.
window.addEventListener('mm-presence-changed', () => {
  document.querySelectorAll('.avatar-online-wrap[data-user-id]').forEach(node => {
    const uid_ = node.getAttribute('data-user-id');
    const online = Store.Presence && Store.Presence.has(uid_);
    node.classList.toggle('is-online', !!online);
  });
  document.querySelectorAll('.presence-badge[data-user-id]').forEach(node => {
    const uid_ = node.getAttribute('data-user-id');
    const online = Store.Presence && Store.Presence.has(uid_);
    node.classList.toggle('is-offline', !online);
  });
  document.querySelectorAll('.presence-inline[data-user-id]').forEach(node => {
    const uid_ = node.getAttribute('data-user-id');
    const online = Store.Presence && Store.Presence.has(uid_);
    node.classList.toggle('is-offline', !online);
  });
});
function restoreSession() {
  const id = localStorage.getItem('dailywater-session');
  if (!id) return null;
  return Store.data.users.find(u => u.id === id) || null;
}

/* ─── Helpers: data accessors ──────────────────────────────── */
function getCustomers() {
  return Store.data.users.filter(u => u.role === 'customer');
}
function getCustomer(id) {
  return Store.data.users.find(u => u.id === id);
}
function getDelivery(customerId, date) {
  return Store.data.deliveries.find(d => d.customerId === customerId && d.date === date);
}
function isPaused(customerId, date) {
  return Store.data.pauses.some(p =>
    p.customerId === customerId && date >= p.from && date <= p.to
  );
}

// Delivery frequency: daily | alternate | weekly | monthly. Anchor is the customer's created_at.
// Customers added before this feature default to 'daily' (every day) — backwards compatible.
function isDeliveryDue(customer, dateStr) {
  const freq = customer.frequency || 'daily';
  if (freq === 'daily') return true;
  const anchor = (customer.created_at || '').slice(0, 10);
  if (!anchor || dateStr < anchor) return freq === 'daily';
  const days = Math.round((new Date(dateStr + 'T00:00:00') - new Date(anchor + 'T00:00:00')) / 86400000);
  if (freq === 'alternate') return days % 2 === 0;
  if (freq === 'weekly') return days % 7 === 0;
  if (freq === 'monthly') {
    const a = new Date(anchor + 'T00:00:00');
    const t = new Date(dateStr + 'T00:00:00');
    const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    return t.getDate() === Math.min(a.getDate(), lastDay);
  }
  return true;
}

function fmtPlan(customer) {
  const qty = fmtQty(customer.dailyMl || 0);
  const freq = customer.frequency || 'daily';
  if (freq === 'daily')     return qty + ' / day';
  if (freq === 'alternate') return qty + ' / alt day';
  if (freq === 'weekly')    return qty + ' / week';
  if (freq === 'monthly')   return qty + ' / month';
  return qty;
}
function getHoliday(date) {
  return (Store.data.holidays || []).find(h => h.date === date) || null;
}
function setDelivery(customerId, date, status, photo) {
  const cust = getCustomer(customerId);
  if (!cust) return;
  let row = getDelivery(customerId, date);
  if (!row) {
    row = { id: uid(), customerId, date, status, ml: status === 'delivered' ? cust.dailyMl : 0 };
    Store.data.deliveries.push(row);
  } else {
    row.status = status;
    row.ml = status === 'delivered' ? cust.dailyMl : 0;
  }
  if (photo !== undefined) row.photo = photo;
  Store.save();
}
function customerMonthBill(customerId, month) {
  const price = Store.data.settings.pricePerLitre;
  const deliveries = Store.data.deliveries.filter(d =>
    d.customerId === customerId && d.date.startsWith(month) && d.status === 'delivered'
  );
  const totalMl = deliveries.reduce((s, d) => s + d.ml, 0);
  const milkAmt = (totalMl / 1000) * price;
  // Bill only counts delivered extras — pending/confirmed don't add to outstanding yet
  const extras = Store.data.extraOrders.filter(o =>
    o.customerId === customerId && o.date.startsWith(month) && o.status === 'delivered'
  );
  const products = Store.data.settings.products;
  const extraAmt = extras.reduce((s, o) => s + (products[o.productKey]?.price || 0) * o.qty, 0);
  const paid = Store.data.payments
    .filter(p => p.customerId === customerId && p.month === month)
    .reduce((s, p) => s + p.amount, 0);
  return {
    month, totalMl, deliveries: deliveries.length, milkAmt, extras, extraAmt,
    total: milkAmt + extraAmt, paid, due: Math.max(0, milkAmt + extraAmt - paid)
  };
}
function todayStatus(customerId) {
  const today = todayISO();
  if (isPaused(customerId, today)) return { status: 'paused', label: 'Paused' };
  const row = getDelivery(customerId, today);
  if (!row) return { status: 'pending', label: 'Pending' };
  if (row.status === 'delivered') return { status: 'delivered', label: 'Delivered' };
  if (row.status === 'skipped') return { status: 'skipped', label: 'Skipped' };
  return { status: 'pending', label: 'Pending' };
}
function notify(userId, type, title, body) {
  Store.data.notifications.push({
    id: uid(), userId, type, title, body,
    date: new Date().toISOString(), read: false
  });
  Store.save();
  // Show in-app popup if recipient is currently logged in
  if (App.user && App.user.id === userId) {
    showNotificationPopup(type, title, body);
  }
  // Browser notification (if user has granted permission)
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon-192.png', tag: type + '-' + uid() }); } catch (e) {}
  }
}

function showNotificationPopup(type, title, body) {
  const host = document.getElementById('popupHost') || (() => {
    const h = el('div', { id: 'popupHost', class: 'popup-host' });
    document.body.appendChild(h);
    return h;
  })();
  const icon = type === 'payment' ? '💳' : type === 'order' ? '🛒' : type === 'pause' ? '⏸' : type === 'delivery' ? '💧' : '🔔';
  const popup = el('div', { class: 'popup-card', onclick: () => { popup.remove(); goNotifications(); } }, [
    el('div', { class: 'popup-icon' }, icon),
    el('div', { class: 'popup-body' }, [
      el('div', { class: 'popup-title' }, title),
      el('div', { class: 'popup-sub' }, body)
    ]),
    el('button', {
      class: 'popup-close', 'aria-label': 'Dismiss',
      onclick: (e) => { e.stopPropagation(); popup.remove(); }
    }, '×')
  ]);
  host.appendChild(popup);
  // Auto-fade after 5s
  setTimeout(() => { if (popup.parentNode) { popup.classList.add('fading'); setTimeout(() => popup.remove(), 400); } }, 5000);
}
function getNotifs(userId) {
  return Store.data.notifications
    .filter(n => n.userId === userId)
    .sort((a, b) => b.date.localeCompare(a.date));
}
function unreadCount(userId) {
  return getNotifs(userId).filter(n => !n.read).length;
}

/* ─── DOM helpers ──────────────────────────────────────────── */
const $view = document.getElementById('view');
const $tabbar = document.getElementById('tabbar');
const $modal = document.getElementById('modal');
const $modalBody = document.getElementById('modalBody');
const $toastHost = document.getElementById('toastHost');
const $waBtn = document.getElementById('waBtn');

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else if (k === 'dataset') Object.assign(e.dataset, attrs[k]);
    else if (attrs[k] === true) e.setAttribute(k, '');
    else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function toast(msg, kind = '') {
  const t = el('div', { class: 'toast' + (kind ? ' ' + kind : '') }, msg);
  $toastHost.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// Stack of "back" handlers so swipe-back / browser-back / Escape go back through modal
// layers and settings subpages instead of exiting the app.
const _popHandlers = [];
function pushBackHandler(handler) {
  history.pushState({ kind: 'mm', depth: _popHandlers.length + 1 }, '');
  _popHandlers.push(handler);
}
function popBack() {
  // Programmatic back — triggers the popstate listener which runs the handler.
  if (_popHandlers.length > 0) history.back();
}
window.addEventListener('popstate', () => {
  const handler = _popHandlers.pop();
  if (handler) {
    try { handler(); } catch (e) { console.warn('back handler failed', e); }
  }
});

function openModal(title, contentNode) {
  const wasOpen = !$modal.hidden;
  clear($modalBody);
  if (title) $modalBody.appendChild(el('h2', {}, title));
  $modalBody.appendChild(contentNode);
  $modal.hidden = false;
  document.body.style.overflow = 'hidden';
  // When swapping content into an already-open modal (e.g. detail → edit form),
  // reuse the existing back handler instead of stacking a second one — a stray
  // popstate would otherwise pop the just-added handler and tear the modal down.
  if (!wasOpen) {
    pushBackHandler(() => {
      $modal.hidden = true;
      document.body.style.overflow = '';
      clear($modalBody);
    });
  }
}
function closeModal() {
  if ($modal.hidden) return;
  popBack();
}
$modal.addEventListener('click', (e) => {
  if (e.target.dataset.close !== undefined) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$modal.hidden) closeModal();
});

function confirmDialog(title, body, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const wrap = el('div', {}, [
      el('p', { class: 'text-muted', style: 'margin-bottom:18px' }, body),
      el('div', { class: 'row gap-sm' }, [
        el('button', { class: 'btn btn-ghost btn-block', onclick: () => { closeModal(); resolve(false); } }, 'Cancel'),
        el('button', { class: 'btn btn-primary btn-block', onclick: () => { closeModal(); resolve(true); } }, confirmLabel)
      ])
    ]);
    openModal(title, wrap);
  });
}

/* ─── Icons (inline SVG) ───────────────────────────────────── */
const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5L12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="13" height="11" rx="1"/><path d="M14 9h4l3 4v4h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="17" cy="19" r="2"/></svg>',
  bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
};
function icon(name) { return el('span', { html: ICON[name] || '' }); }

// Pending extras orders awaiting owner's action (for the topbar order badge).
function pendingOrderCount(user) {
  if (!user || !Store.data.extraOrders) return 0;
  if (user.role === 'owner') {
    return Store.data.extraOrders.filter(o => o.ownerId === user.id && o.status === 'pending').length;
  }
  if (user.role === 'customer') {
    return Store.data.extraOrders.filter(o => o.customerId === user.id && (o.status === 'pending' || o.status === 'confirmed')).length;
  }
  return 0;
}

// Profile avatar shown on the left of the topbar — tappable, opens settings (owner) or no-op.
function topbarAvatar(user) {
  if (!user) return null;
  const onClick = user.role === 'owner' ? () => openOwnerSettings()
                : user.role === 'admin' ? () => adminSettingsModal()
                : null;
  const initial = (user.name || '?')[0].toUpperCase();
  return el('button', {
    class: 'topbar-avatar' + (user.photo ? ' has-photo' : ''),
    onclick: onClick || (() => {}),
    'aria-label': 'Profile',
    style: user.photo ? 'background-image:url(' + user.photo + ')' : ''
  }, user.photo ? '' : initial);
}

/* ─── Top bar builder ──────────────────────────────────────── */
function topbar(opts = {}) {
  // Left: back button on subviews, otherwise profile avatar (always shown when logged in)
  const left = opts.back
    ? el('button', { class: 'icon-btn', onclick: opts.back, 'aria-label': 'Back', html: ICON.back })
    : (App.user ? topbarAvatar(App.user) : null);

  const titleWrap = el('div', { style: 'flex:1;min-width:0' }, [
    el('h1', {}, opts.title || ''),
    opts.subtitle ? el('div', { class: 'topbar-sub' }, opts.subtitle) : null
  ]);

  const actions = el('div', { class: 'row gap-sm' });

  // Order/extras icon with count badge — owner sees pending; customer sees their active orders
  if (opts.bell && App.user && (App.user.role === 'owner' || App.user.role === 'customer')) {
    const cnt = pendingOrderCount(App.user);
    const onTap = App.user.role === 'owner'
      ? () => ownerOrdersInbox()
      : () => { App.customerTab = 'extras'; viewCustomer(); };
    const oWrap = el('div', { class: 'bell-wrap' }, [
      el('button', { class: 'icon-btn', onclick: onTap, 'aria-label': 'Orders', html: ICON.bag })
    ]);
    if (cnt > 0) oWrap.appendChild(el('span', { class: 'bell-badge' }, cnt > 99 ? '99+' : String(cnt)));
    actions.appendChild(oWrap);
  }

  // Bell with count badge
  if (opts.bell && App.user) {
    const cnt = unreadCount(App.user.id);
    const wrap = el('div', { class: 'bell-wrap' }, [
      el('button', { class: 'icon-btn', onclick: () => goNotifications(), 'aria-label': 'Notifications', html: ICON.bell })
    ]);
    if (cnt > 0) wrap.appendChild(el('span', { class: 'bell-badge' }, cnt > 99 ? '99+' : String(cnt)));
    actions.appendChild(wrap);
  }
  if (opts.logout) {
    actions.appendChild(el('button', { class: 'icon-btn', onclick: logout, 'aria-label': 'Sign out', html: ICON.logout }));
  }
  if (opts.right) actions.appendChild(opts.right);

  return el('header', { class: 'topbar' }, [left, titleWrap, actions]);
}

/* ─── Auth: phone + OTP (admin / owner) / password (customer + delivery_boy) ── */
function viewLogin() {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);

  // Stages: phone → otp (admin or owner) | password (customer/boy) | set_password (legacy)
  //         | signup (only for new owner registration) | pending (owner awaiting approval) | rejected
  const state = { mobile: '', otp: '', password: '', password2: '', stage: 'phone', existingUser: null, signupRole: 'owner', remember: true };
  // Pre-fill mobile (and password for that mobile) from remembered creds, if any
  try {
    const raw = localStorage.getItem('dailywater-creds');
    if (raw) {
      const c = JSON.parse(raw);
      if (c && c.mobile) state.mobile = c.mobile;
    }
  } catch (e) {}

  const render = () => {
    clear($view);
    const root = el('div', { class: 'login' }, [
      el('div', { class: 'login-hero' }, [
        el('div', { class: 'login-logo' }, '💧'),
        el('div', {}, [
          el('h1', {}, 'DailyWater'),
          el('p', { class: 'login-sub' }, t('app_tagline')),
          el('div', { class: 'build-tag' }, '✦ New look · build 6')
        ]),
        el('div', { class: 'lang-row' }, ['en','hi','mr'].map(lng => el('button', {
          class: 'lang-btn' + ((Store.data.language || 'en') === lng ? ' active' : ''),
          type: 'button',
          onclick: () => { setLanguage(lng); render(); }
        }, lng === 'en' ? 'English' : lng === 'hi' ? 'हिन्दी' : 'मराठी')))
      ])
    ]);

    const form = el('form', { class: 'login-form', onsubmit: (e) => { e.preventDefault(); next(); } });

    if (state.stage === 'phone') {
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('mobile')),
        el('div', { class: 'input-prefix-row' }, [
          el('span', { class: 'input-prefix' }, '+91'),
          el('input', {
            class: 'input', type: 'tel', inputmode: 'numeric', maxlength: 10,
            placeholder: t('phone_placeholder'), value: state.mobile, autofocus: true,
            oninput: (e) => state.mobile = e.target.value.replace(/\D/g, '').slice(0, 10)
          })
        ])
      ]));
      form.appendChild(el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t('continue_btn')));
      // Explicit signup CTA — routes new dairy owners straight to the signup form.
      form.appendChild(el('div', {
        class: 'signup-cta',
        style: 'text-align:center;margin-top:18px;font-size:14px;color:var(--text-muted)'
      }, [
        'New supplier? ',
        el('button', {
          class: 'link-btn',
          type: 'button',
          style: 'display:inline;padding:0;font-weight:700',
          onclick: () => {
            if (state.mobile.length !== 10) return toast('Enter your 10-digit mobile first', 'error');
            const existing = Store.data.users.find(u => u.mobile === state.mobile);
            if (existing) return toast('This number is already registered — just tap Continue', 'error');
            state.stage = 'signup';
            state.signupRole = 'owner';
            render();
          }
        }, 'Sign up →')
      ]));

    } else if (state.stage === 'otp') {
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('enter_otp') + ' +91 ' + state.mobile),
        el('input', {
          class: 'input otp', type: 'tel', inputmode: 'numeric', maxlength: 4,
          placeholder: '••••', value: state.otp, autofocus: true,
          oninput: (e) => {
            state.otp = e.target.value.replace(/\D/g, '').slice(0, 4);
            e.target.value = state.otp;
            if (state.otp.length === 4) next();
          }
        })
      ]));
      form.appendChild(el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t('verify_continue')));
      form.appendChild(el('button', {
        class: 'link-btn', type: 'button', style: 'margin-top:12px',
        onclick: () => { state.stage = 'phone'; state.otp = ''; render(); }
      }, t('change_number')));
      const otpHint = state.existingUser && state.existingUser.role === 'admin' ? 'Admin OTP: 1235' : t('demo_otp_hint');
      form.appendChild(el('div', { class: 'hint' }, otpHint));

    } else if (state.stage === 'password') {
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('enter_password') + ' · +91 ' + state.mobile),
        el('input', {
          class: 'input', type: 'password', autocomplete: 'current-password',
          autofocus: true, value: state.password,
          oninput: (e) => state.password = e.target.value
        })
      ]));
      // Remember password checkbox — prefilled mobile + password on next launch
      form.appendChild(el('label', {
        class: 'remember-row', style: 'display:flex;align-items:center;gap:8px;margin:8px 0 4px;font-size:13px;cursor:pointer'
      }, [
        el('input', {
          type: 'checkbox', id: 'lg-remember', checked: state.remember,
          onchange: (e) => state.remember = e.target.checked,
          style: 'width:18px;height:18px;accent-color:var(--primary)'
        }),
        el('span', {}, 'Remember password on this device')
      ]));
      form.appendChild(el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t('login')));
      form.appendChild(el('button', {
        class: 'link-btn', type: 'button', style: 'margin-top:12px',
        onclick: () => { state.stage = 'phone'; state.password = ''; render(); }
      }, t('change_number')));
      // Forgot password → owner WhatsApp
      const ownerWa = (Store.data.settings && Store.data.settings.ownerWhatsApp) || '';
      if (ownerWa) {
        form.appendChild(el('a', {
          class: 'link-btn', style: 'display:block;margin-top:8px;text-align:center',
          target: '_blank', rel: 'noopener',
          href: waLink(ownerWa,
            'Hi, this is +91 ' + state.mobile + '. I forgot my DailyWater password — please reset it for me.')
        }, t('forgot_password')));
      }

    } else if (state.stage === 'set_password') {
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('set_password') + ' · +91 ' + state.mobile),
        el('div', { class: 'hint', style: 'margin-bottom:8px' }, t('set_password_hint')),
        el('input', {
          class: 'input', type: 'password', autocomplete: 'new-password',
          autofocus: true, placeholder: t('set_password'), value: state.password,
          oninput: (e) => state.password = e.target.value
        })
      ]));
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('confirm_password')),
        el('input', {
          class: 'input', type: 'password', autocomplete: 'new-password',
          placeholder: t('confirm_password'), value: state.password2,
          oninput: (e) => state.password2 = e.target.value
        })
      ]));
      form.appendChild(el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, t('continue_btn')));
      form.appendChild(el('button', {
        class: 'link-btn', type: 'button', style: 'margin-top:12px',
        onclick: () => { state.stage = 'phone'; state.password = ''; state.password2 = ''; render(); }
      }, t('change_number')));

    } else if (state.stage === 'signup') {
      // Multi-tenant SaaS: only owners can self-signup. Customers and delivery boys are added by their owner.
      form.appendChild(el('div', { class: 'field' }, [
        el('div', { class: 'hint', style: 'margin-bottom:8px' },
          'New supplier registration. After signup, the software admin will review and approve your account.')
      ]));
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('your_name')),
        el('input', { class: 'input', id: 'su-name', type: 'text', autofocus: true, placeholder: 'Your full name' })
      ]));
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, 'Business name'),
        el('input', { class: 'input', id: 'su-biz', type: 'text', placeholder: 'e.g. AquaPure Waters' })
      ]));
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, 'WhatsApp number for customers'),
        el('input', { class: 'input', id: 'su-wa', type: 'tel', inputmode: 'numeric', maxlength: 10, placeholder: '10-digit mobile' })
      ]));
      // Password (used after approval)
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('set_password')),
        el('input', { class: 'input', id: 'su-pw', type: 'password', autocomplete: 'new-password', placeholder: 'min 4 characters' })
      ]));
      form.appendChild(el('div', { class: 'field' }, [
        el('label', {}, t('confirm_password')),
        el('input', { class: 'input', id: 'su-pw2', type: 'password', autocomplete: 'new-password', placeholder: 'Re-enter' })
      ]));
      form.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' },
        'Customer & delivery boy IDs are created by the dairy owner from inside the app. They cannot self-register.'));
      form.appendChild(el('button', { class: 'btn btn-primary btn-block', style: 'margin-top:14px', type: 'submit' },
        'Apply for owner account'));
      form.appendChild(el('button', {
        class: 'link-btn', type: 'button', style: 'margin-top:12px',
        onclick: () => { state.stage = 'phone'; render(); }
      }, '← Back'));

    } else if (state.stage === 'pending') {
      form.appendChild(el('div', { class: 'card', style: 'text-align:center;margin-top:18px' }, [
        el('div', { style: 'font-size:48px' }, '⏳'),
        el('div', { style: 'font-weight:700;font-size:16px;margin-top:8px' }, 'Awaiting approval'),
        el('div', { class: 'text-muted', style: 'font-size:14px;margin-top:8px' },
          'Your owner account is waiting for the software admin to approve. You\'ll be notified once approved.'),
        el('div', { class: 'text-muted', style: 'font-size:13px;margin-top:14px' },
          'Need to follow up? Contact the admin directly.')
      ]));
      form.appendChild(el('a', {
        class: 'btn btn-primary btn-block', style: 'margin-top:14px',
        href: waLink('918858141463', 'Hi, I applied for a DailyWater owner account (' + state.mobile + '). Please review my request.'),
        target: '_blank', rel: 'noopener'
      }, 'WhatsApp admin'));
      form.appendChild(el('button', {
        class: 'link-btn', type: 'button', style: 'margin-top:12px',
        onclick: () => { state.stage = 'phone'; render(); }
      }, '← Back to login'));

    } else if (state.stage === 'rejected') {
      form.appendChild(el('div', { class: 'card', style: 'text-align:center;margin-top:18px' }, [
        el('div', { style: 'font-size:48px' }, '🚫'),
        el('div', { style: 'font-weight:700;font-size:16px;margin-top:8px' }, 'Account not approved'),
        el('div', { class: 'text-muted', style: 'font-size:14px;margin-top:8px' },
          'The software admin has not approved this owner account. Please contact admin if you believe this is an error.')
      ]));
      form.appendChild(el('a', {
        class: 'btn btn-primary btn-block', style: 'margin-top:14px',
        href: waLink('918858141463', 'Hi, my DailyWater owner application (' + state.mobile + ') was rejected. Could you reconsider?'),
        target: '_blank', rel: 'noopener'
      }, 'WhatsApp admin'));
      form.appendChild(el('button', {
        class: 'link-btn', type: 'button', style: 'margin-top:12px',
        onclick: () => { state.stage = 'phone'; render(); }
      }, '← Back to login'));
    }

    root.appendChild(form);
    $view.appendChild(root);
  };

  const next = async () => {
    if (state.stage === 'phone') {
      if (state.mobile.length !== 10) return toast('Enter a valid 10-digit number', 'error');
      // Admin role lookup wins over any other matching mobile (in case a customer happens to share the admin number)
      const existing = Store.data.users.find(u => u.mobile === state.mobile && u.role === 'admin')
                    || Store.data.users.find(u => u.mobile === state.mobile);
      if (!existing) {
        // New user → owner-only signup. Customers/boys are added by their owner.
        state.stage = 'signup';
        state.signupRole = 'owner';
        render();
        return;
      }
      state.existingUser = existing;
      // If we have remembered creds for THIS mobile, prefill password
      try {
        const raw = localStorage.getItem('dailywater-creds');
        if (raw) {
          const c = JSON.parse(raw);
          if (c && c.mobile === state.mobile && c.password) {
            state.password = c.password;
            state.remember = true;
          }
        }
      } catch (e) {}
      // Admin: OTP only (1235)
      if (existing.role === 'admin') {
        state.stage = 'otp';
        render();
        toast('Admin OTP: 1235');
        return;
      }
      // Owner: must be approved + uses password
      if (existing.role === 'owner') {
        if (existing.status === 'pending')  { state.stage = 'pending';  render(); return; }
        if (existing.status === 'rejected') { state.stage = 'rejected'; render(); return; }
        // approved → password (or set-password if no hash yet)
        state.stage = existing.password_hash ? 'password' : 'set_password';
        render();
        if (!existing.password_hash) toast('Set a password to continue');
        return;
      }
      // customer / delivery_boy → password (or set-password)
      if (existing.password_hash) {
        state.stage = 'password';
        render();
      } else {
        state.stage = 'set_password';
        render();
        toast('Set a password to continue');
      }

    } else if (state.stage === 'otp') {
      if (state.otp.length !== 4) return toast('Enter the 4-digit OTP', 'error');
      const u = state.existingUser;
      const expected = u.role === 'admin' ? '1235' : '1234';
      if (state.otp !== expected) return toast(t('wrong_password'), 'error');
      setSession(u);
      toast(t('welcome_back') + ', ' + u.name.split(' ')[0]);
      navigate(u.role);

    } else if (state.stage === 'password') {
      if (!state.password || state.password.length < 4) return toast(t('password_min'), 'error');
      const u = state.existingUser;
      const ok = await verifyPassword(state.password, u.id, u.password_hash);
      if (!ok) return toast(t('wrong_password'), 'error');
      // Subscription guards: customer/boy hard-blocked if dairy expired; owner allowed in (lands on locked screen)
      if (u.role === 'customer' || u.role === 'delivery_boy') {
        const dairy = u.ownerId ? getOwnerById(u.ownerId) : null;
        if (dairy && ownerSubscriptionState(dairy) === 'expired') {
          return toast('Service expired — contact your supplier', 'error');
        }
      }
      // Persist or clear remembered creds based on the checkbox
      if (state.remember) {
        try { localStorage.setItem('dailywater-creds', JSON.stringify({ mobile: state.mobile, password: state.password })); } catch (e) {}
      } else {
        try { localStorage.removeItem('dailywater-creds'); } catch (e) {}
      }
      setSession(u);
      toast(t('welcome_back') + ', ' + u.name.split(' ')[0]);
      navigate(u.role);

    } else if (state.stage === 'set_password') {
      if (!state.password || state.password.length < 4) return toast(t('password_min'), 'error');
      if (state.password !== state.password2) return toast(t('password_mismatch'), 'error');
      const u = state.existingUser;
      // Subscription guard for customer/boy
      if (u.role === 'customer' || u.role === 'delivery_boy') {
        const dairy = u.ownerId ? getOwnerById(u.ownerId) : null;
        if (dairy && ownerSubscriptionState(dairy) === 'expired') {
          return toast('Service expired — contact your supplier', 'error');
        }
      }
      u.password_hash = await hashPassword(state.password, u.id);
      Store.save();
      setSession(u);
      toast(t('welcome_back') + ', ' + u.name.split(' ')[0]);
      navigate(u.role);

    } else if (state.stage === 'signup') {
      // Owner self-registration → status='pending', awaits admin approval
      const name = document.getElementById('su-name').value.trim();
      const biz = document.getElementById('su-biz').value.trim();
      const wa = (document.getElementById('su-wa').value || '').replace(/\D/g, '');
      const pw = document.getElementById('su-pw').value;
      const pw2 = document.getElementById('su-pw2').value;
      if (!name) return toast('Enter your name', 'error');
      if (!biz)  return toast('Enter your business name', 'error');
      if (wa && wa.length !== 10) return toast('WhatsApp must be 10 digits (or leave blank)', 'error');
      if (!pw || pw.length < 4) return toast(t('password_min'), 'error');
      if (pw !== pw2) return toast(t('password_mismatch'), 'error');
      const newId = uid();
      const user = {
        id: newId,
        mobile: state.mobile,
        name,
        role: 'owner',
        status: 'pending',
        customer_limit: 10,
        ownerId: null,
        password_hash: await hashPassword(pw, newId)
      };
      Store.data.users.push(user);
      // Pre-create their dairy_settings record (visible after approval)
      Store.data.dairySettings = Store.data.dairySettings || {};
      Store.data.dairySettings[newId] = Object.assign(defaultDairySettings(), {
        businessName: biz, ownerWhatsApp: wa ? '91' + wa : ''
      });
      Store.save();
      // Notify admin
      const admin = getAdminUser();
      if (admin) notify(admin.id, 'order', 'New owner signup',
        name + ' (' + biz + ') applied — phone ' + state.mobile + '. Tap to review.');
      // Show pending screen
      state.existingUser = user;
      state.stage = 'pending';
      render();
      toast('Application submitted — admin will review', 'success');
    }
  };
  render();
}

function logout() {
  setSession(null);
  // Drop remembered credentials so the user sees a fresh login screen
  try { localStorage.removeItem('dailywater-creds'); } catch (e) {}
  navigate('login');
}

/* ─── Customer self-onboarding (QR / join link: ?join=<ownerId>) ─── */
function viewJoin(ownerId) {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  const state = { mobile: '', size: BOTTLE_SIZES_ML[0], count: 1, freq: 'daily' };
  const ownerName = () => {
    const ds = Store.data.dairySettings && Store.data.dairySettings[ownerId];
    const o = Store.data.users.find(u => u.id === ownerId && u.role === 'owner');
    return (ds && ds.businessName) || (o && o.name) || 'Water delivery';
  };
  const render = () => {
    clear($view);
    const root = el('div', { class: 'login' }, [
      el('div', { class: 'login-hero' }, [
        el('div', { class: 'login-logo' }, '💧'),
        el('div', {}, [
          el('h1', {}, ownerName()),
          el('p', { class: 'login-sub' }, 'Register for water delivery')
        ])
      ])
    ]);
    const form = el('form', { class: 'login-form', onsubmit: (e) => { e.preventDefault(); submit(); } });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Your name'),
      el('input', { class: 'input', id: 'jn-name', autofocus: true })
    ]));
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Mobile (10 digits)'),
      el('div', { class: 'input-prefix-row' }, [
        el('span', { class: 'input-prefix' }, '+91'),
        el('input', { class: 'input', id: 'jn-mobile', type: 'tel', inputmode: 'numeric', maxlength: 10,
          value: state.mobile, oninput: (e) => { state.mobile = e.target.value.replace(/\D/g, '').slice(0, 10); e.target.value = state.mobile; } })
      ])
    ]));
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Delivery address'),
      el('input', { class: 'input', id: 'jn-addr' })
    ]));
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Bottle size'),
      el('select', { class: 'select', id: 'jn-size' }, BOTTLE_SIZES_ML.map(sz =>
        el('option', { value: sz, selected: sz === state.size }, fmtQty(sz) + ' bottle')))
    ]));
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Bottles per delivery'),
      el('select', { class: 'select', id: 'jn-count' }, [1,2,3,4,5,6,7,8,9,10].map(n =>
        el('option', { value: n, selected: n === state.count }, String(n))))
    ]));
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Delivery frequency'),
      el('select', { class: 'select', id: 'jn-freq' }, [
        { v: 'daily', l: 'Daily' }, { v: 'alternate', l: 'Alternate days' },
        { v: 'weekly', l: 'Weekly' }, { v: 'monthly', l: 'Monthly' }
      ].map(o => el('option', { value: o.v, selected: o.v === state.freq }, o.l)))
    ]));
    form.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Set a password'),
      el('input', { class: 'input', id: 'jn-pw', type: 'password' })
    ]));
    form.appendChild(el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Join & continue'));
    root.appendChild(form);
    $view.appendChild(root);
  };
  const submit = async () => {
    const name = (document.getElementById('jn-name').value || '').trim();
    const mobile = (document.getElementById('jn-mobile').value || '').replace(/\D/g, '');
    const addr = (document.getElementById('jn-addr').value || '').trim();
    const size = +document.getElementById('jn-size').value;
    const count = +document.getElementById('jn-count').value || 1;
    const freq = document.getElementById('jn-freq').value || 'daily';
    const pw = document.getElementById('jn-pw').value;
    if (!name) return toast('Enter your name', 'error');
    if (mobile.length !== 10) return toast('Enter 10-digit mobile', 'error');
    if (!pw || pw.length < 4) return toast(t('password_min'), 'error');
    const owner = Store.data.users.find(u => u.id === ownerId && u.role === 'owner');
    if (!owner) return toast('Invalid or expired invite link', 'error');
    if (Store.data.users.some(u => u.mobile === mobile)) return toast('That mobile is already registered — please log in instead', 'error');
    const newId = uid();
    const qty = size * count;
    const planLabel = ({ daily: 'Daily', alternate: 'Alternate', weekly: 'Weekly', monthly: 'Monthly' })[freq] + ' ' + (count > 1 ? count + ' × ' : '') + fmtQty(size);
    const user = {
      id: newId, mobile, name, role: 'customer', status: 'approved', ownerId,
      address: addr, dailyMl: qty, frequency: freq, plan: planLabel,
      created_at: new Date().toISOString(), password_hash: await hashPassword(pw, newId)
    };
    Store.data.users.push(user);
    Store.save();
    notify(ownerId, 'order', 'New customer joined', name + ' registered via your invite link.');
    try { history.replaceState({}, '', location.pathname); } catch (e) {}
    setSession(user);
    toast('Welcome, ' + name.split(' ')[0] + '!', 'success');
    navigate('customer');
  };
  render();
}

/* ─── Tab bar builder ──────────────────────────────────────── */
function buildTabbar(tabs, current, onPick) {
  clear($tabbar);
  tabs.forEach(t => {
    $tabbar.appendChild(el('button', {
      class: 'tab' + (current === t.key ? ' active' : ''),
      onclick: () => onPick(t.key)
    }, [
      el('span', { html: ICON[t.icon] }),
      el('span', {}, t.label)
    ]));
  });
  $tabbar.hidden = false;
  document.body.classList.remove('no-tabs');
}

/* ─── Owner dashboard ──────────────────────────────────────── */
/* ─── Admin (software-seller) dashboard ──────────────────── */
function viewAdmin() {
  document.body.classList.remove('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);

  $view.appendChild(topbar({
    title: 'Software Admin',
    subtitle: 'Manage suppliers',
    bell: true,
    right: el('div', { class: 'row gap-sm' }, [
      el('button', { class: 'icon-btn', onclick: () => adminSettingsModal(), 'aria-label': 'Admin settings', html: ICON.settings || '⚙️' }),
      el('button', { class: 'icon-btn', onclick: () => { setSession(null); navigate('login'); }, 'aria-label': 'Sign out', html: ICON.logout || '⤴' })
    ])
  }));

  const page = el('div', { class: 'page' });

  const allOwners = Store.data.users.filter(u => u.role === 'owner');
  const pending = allOwners.filter(o => o.status === 'pending');
  const approved = allOwners.filter(o => o.status === 'approved');
  const rejected = allOwners.filter(o => o.status === 'rejected');

  // Headline stats
  page.appendChild(el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Approved owners'),
      el('div', { class: 'stat-value' }, String(approved.length))
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Pending approval'),
      el('div', { class: 'stat-value', style: pending.length ? 'color:var(--warning)' : '' }, String(pending.length))
    ])
  ]));

  // Pending requests — call to action
  page.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [
    el('h2', {}, 'Pending applications (' + pending.length + ')')
  ]));
  if (pending.length === 0) {
    page.appendChild(el('div', { class: 'card text-muted', style: 'font-size:13px' }, 'No pending applications.'));
  } else {
    const list = el('div', { class: 'list' });
    pending.forEach(o => {
      const ds = (Store.data.dairySettings || {})[o.id] || {};
      list.appendChild(el('div', { class: 'list-item is-clickable', onclick: () => adminOwnerDetail(o.id) }, [
        el('div', { class: 'li-avatar', style: 'background:#FEF3C7;color:#92400E' }, '⏳'),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, o.name + (ds.businessName ? ' — ' + ds.businessName : '')),
          el('div', { class: 'li-sub' }, '+91 ' + o.mobile + ' · tap to review')
        ]),
        el('span', { class: 'badge warn' }, 'Pending')
      ]));
    });
    page.appendChild(list);
  }

  // Approved owners
  page.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [
    el('h2', {}, 'Approved owners (' + approved.length + ')')
  ]));
  if (approved.length === 0) {
    page.appendChild(el('div', { class: 'card text-muted', style: 'font-size:13px' }, 'No approved owners yet.'));
  } else {
    const list = el('div', { class: 'list' });
    approved.forEach(o => {
      const used = ownerCount(o.id);
      const limit = Number(o.customer_limit) || 10;
      const ds = (Store.data.dairySettings || {})[o.id] || {};
      const overUsage = used >= limit;
      list.appendChild(el('div', { class: 'list-item is-clickable', onclick: () => adminOwnerDetail(o.id) }, [
        el('div', { class: 'li-avatar' }, (o.name || '?')[0].toUpperCase()),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, o.name + (ds.businessName ? ' · ' + ds.businessName : '')),
          el('div', { class: 'li-sub' }, '+91 ' + o.mobile + ' · ' + used + '/' + limit + ' IDs used')
        ]),
        el('span', { class: 'badge ' + (overUsage ? 'warn' : 'success') }, overUsage ? 'At limit' : 'OK')
      ]));
    });
    page.appendChild(list);
  }

  // Rejected owners (collapsed)
  if (rejected.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [
      el('h2', { style: 'font-size:14px;color:var(--muted)' }, 'Rejected (' + rejected.length + ')')
    ]));
    const list = el('div', { class: 'list' });
    rejected.forEach(o => {
      list.appendChild(el('div', { class: 'list-item is-clickable', style: 'opacity:.7', onclick: () => adminOwnerDetail(o.id) }, [
        el('div', { class: 'li-avatar', style: 'background:#FEE2E2;color:#991B1B' }, '🚫'),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, o.name),
          el('div', { class: 'li-sub' }, '+91 ' + o.mobile)
        ]),
        el('span', { class: 'badge danger' }, 'Rejected')
      ]));
    });
    page.appendChild(list);
  }

  $view.appendChild(page);
}

function adminOwnerDetail(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) return toast('Owner not found', 'error');
  const ds = (Store.data.dairySettings || {})[ownerId] || {};
  const used = ownerCount(ownerId);
  const limit = Number(owner.customer_limit) || 10;
  const customers = Store.data.users.filter(u => u.ownerId === ownerId && u.role === 'customer').length;
  const boys = Store.data.users.filter(u => u.ownerId === ownerId && u.role === 'delivery_boy').length;

  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
    el('div', { style: 'font-weight:700;font-size:16px' }, owner.name),
    ds.businessName ? el('div', { class: 'text-muted', style: 'font-size:13px;margin-top:2px' }, ds.businessName) : null,
    el('div', { class: 'text-muted', style: 'font-size:13px;margin-top:6px' }, '+91 ' + owner.mobile),
    ds.ownerWhatsApp ? el('div', { class: 'text-muted', style: 'font-size:12px;margin-top:2px' }, 'WhatsApp: +' + ds.ownerWhatsApp) : null,
    el('div', { style: 'margin-top:8px' }, [
      el('span', { class: 'badge ' + (owner.status === 'approved' ? 'success' : owner.status === 'pending' ? 'warn' : 'danger') },
        owner.status || 'approved')
    ])
  ]));

  wrap.appendChild(el('div', { class: 'stat-grid', style: 'margin-bottom:12px' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Customers'),
      el('div', { class: 'stat-value' }, String(customers))
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Delivery boys'),
      el('div', { class: 'stat-value' }, String(boys))
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Quota used'),
      el('div', { class: 'stat-value' }, used + ' / ' + limit)
    ])
  ]));

  // Approve / Reject (for pending) + Grant slots (for approved)
  if (owner.status === 'pending') {
    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:8px',
      onclick: async () => {
        owner.status = 'approved';
        // Grant a free trial — only if they don't already have an expiry set
        if (!owner.subscription_expires_at) {
          const now = new Date();
          owner.subscription_started_at = now.toISOString();
          owner.subscription_plan = 'trial';
          owner.subscription_expires_at = new Date(now.getTime() + FREE_TRIAL_DAYS * 86400000).toISOString();
        }
        Store.save();
        notify(owner.id, 'welcome', 'Account approved 🎉',
          'Your dairy account is approved with a ' + FREE_TRIAL_DAYS + '-day free trial. Log in with OTP 1234.');
        toast('Owner approved with ' + FREE_TRIAL_DAYS + '-day trial', 'success');
        closeModal();
        viewAdmin();
      }
    }, 'Approve owner (+ ' + FREE_TRIAL_DAYS + '-day trial)'));
    wrap.appendChild(el('button', {
      class: 'btn btn-danger btn-block', style: 'margin-top:8px',
      onclick: async () => {
        if (!await confirmDialog('Reject this owner?', owner.name + ' (' + owner.mobile + ') will not be able to log in.', 'Reject')) return;
        owner.status = 'rejected';
        Store.save();
        notify(owner.id, 'welcome', 'Account not approved',
          'Your owner application was not approved. Contact admin via WhatsApp for details.');
        toast('Owner rejected');
        closeModal();
        viewAdmin();
      }
    }, 'Reject'));
  } else if (owner.status === 'approved') {
    // Subscription card
    const exp = ownerExpiryInfo(owner);
    const planLabel = exp.plan === 'trial' ? 'Free trial' : (getPlanByKey(exp.plan)?.name || (exp.plan || '—'));
    const subColor = exp.state === 'active' && exp.daysLeft > 7 ? 'success'
                  : exp.state === 'active' ? 'warn'
                  : exp.state === 'grace' ? 'warn'
                  : exp.state === 'unlimited' ? 'info' : 'danger';
    wrap.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px;border:1px solid var(--line)' }, [
      el('div', { style: 'font-weight:700;font-size:14px;margin-bottom:6px' }, 'Subscription'),
      el('div', { class: 'row', style: 'justify-content:space-between' }, [
        el('span', { class: 'text-muted', style: 'font-size:13px' }, 'Plan'),
        el('span', { style: 'font-weight:600;font-size:13px' }, planLabel)
      ]),
      el('div', { class: 'row', style: 'justify-content:space-between;margin-top:4px' }, [
        el('span', { class: 'text-muted', style: 'font-size:13px' }, 'Status'),
        el('span', { class: 'badge ' + subColor },
          exp.state === 'unlimited' ? 'Unlimited'
          : exp.state === 'active' ? exp.daysLeft + ' days left'
          : exp.state === 'grace' ? 'Grace · ' + Math.abs(exp.daysLeft) + 'd over'
          : 'Expired')
      ]),
      exp.expiresAt ? el('div', { class: 'row', style: 'justify-content:space-between;margin-top:4px' }, [
        el('span', { class: 'text-muted', style: 'font-size:12px' }, 'Expires'),
        el('span', { class: 'text-muted', style: 'font-size:12px' }, prettyDate(String(exp.expiresAt).slice(0, 10)))
      ]) : null
    ]));

    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:8px',
      onclick: () => adminMarkPaid(owner.id)
    }, '💰 Mark as paid'));
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
      onclick: () => adminGrantSlots(owner.id)
    }, 'Grant more IDs'));
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
      onclick: () => adminOwnerCustomers(owner.id)
    }, '👥 View customers (' + Store.data.users.filter(u => u.role === 'customer' && u.ownerId === owner.id).length + ')'));
    wrap.appendChild(el('a', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
      href: waLink(owner.mobile, 'Hi ' + owner.name + ', this is the DailyWater admin.'),
      target: '_blank', rel: 'noopener'
    }, 'WhatsApp owner'));
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px;color:var(--warning)',
      onclick: async () => {
        if (!await confirmDialog('Suspend this owner?',
          owner.name + ' will be marked rejected and unable to log in. Their data is preserved.',
          'Suspend')) return;
        owner.status = 'rejected';
        Store.save();
        toast('Owner suspended');
        closeModal();
        viewAdmin();
      }
    }, 'Suspend owner'));
    wrap.appendChild(el('button', {
      class: 'btn btn-danger btn-block', style: 'margin-top:8px',
      onclick: () => adminDeleteOwnerConfirm(owner.id)
    }, '🗑 Delete owner & all data'));
  } else if (owner.status === 'rejected') {
    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:8px',
      onclick: () => {
        owner.status = 'approved';
        Store.save();
        notify(owner.id, 'welcome', 'Account reactivated', 'You can log in again with OTP 1234.');
        toast('Owner reactivated', 'success');
        closeModal();
        viewAdmin();
      }
    }, 'Reactivate owner'));
  }

  openModal('Owner details', wrap);
}

function adminSettingsModal() {
  const cur = adminUpiSettings() || {};
  const plans = getPlans().slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const pending = {
    upiId: cur.upiId || '',
    upiName: cur.upiName || '',
    planPrices: Object.fromEntries(plans.map(p => [p.key, p.price])),
    theme: Store.data.theme || 'auto',
    lang: Store.data.language || 'en'
  };
  let view = 'list'; // 'list' | 'upi' | 'plans' | 'theme' | 'lang'

  const sections = [
    { key: 'upi',   icon: '💳', title: 'UPI Payments',       subtitle: 'For owner subscription payments' },
    { key: 'plans', icon: '💰', title: 'Subscription Plans', subtitle: 'Edit plan prices' },
    { key: 'theme', icon: '🎨', title: 'Appearance',         subtitle: 'Light, dark, or auto' },
    { key: 'lang',  icon: '🌐', title: 'Language',           subtitle: 'App display language' }
  ];

  // Snapshot whatever's typed before re-render so values aren't lost on navigation
  function commitOpenForm() {
    const upi1 = document.getElementById('as-upi-id'); if (upi1) pending.upiId = upi1.value.trim();
    const upi2 = document.getElementById('as-upi-name'); if (upi2) pending.upiName = upi2.value.trim();
    plans.forEach(p => {
      const inp = document.getElementById('plan-' + p.key);
      if (inp) {
        const v = Number(inp.value);
        if (Number.isFinite(v) && v >= 0) pending.planPrices[p.key] = v;
      }
    });
  }

  const wrap = el('div', { class: 'settings-screen' });

  async function doSave() {
    commitOpenForm();
    Store.data.dairySettings = Store.data.dairySettings || {};
    Store.data.dairySettings['u_admin'] = Object.assign(
      defaultDairySettings(),
      Store.data.dairySettings['u_admin'] || {},
      { upiId: pending.upiId, upiName: pending.upiName, businessName: 'DailyWater Admin' }
    );
    plans.forEach(p => {
      const v = pending.planPrices[p.key];
      if (Number.isFinite(v) && v >= 0) p.price = v;
    });
    if (pending.theme !== Store.data.theme) setTheme(pending.theme);
    if (pending.lang !== Store.data.language) setLanguage(pending.lang);
    Store.cacheLocally();
    try {
      if (sb) {
        await sb.from('dairy_settings').upsert({
          ownerId: 'u_admin', upiId: pending.upiId, upiName: pending.upiName,
          businessName: 'DailyWater Admin', pricePerLitre: 0
        }, { onConflict: 'ownerId' });
        await sb.from('subscription_plans').upsert(plans.map(p => ({
          key: p.key, name: p.name, price: p.price,
          duration_days: p.duration_days, active: p.active !== false,
          sort_order: p.sort_order || 0
        })));
      }
    } catch (e) { console.warn('admin settings save failed', e); }
    toast('Settings saved', 'success');
    closeModal();
    viewAdmin();
  }

  function render() {
    commitOpenForm();
    clear(wrap);

    if (view === 'list') {
      // Paytm-style list of category rows
      const list = el('div', { class: 'sett-list' });
      sections.forEach(sec => {
        list.appendChild(el('button', {
          type: 'button', class: 'sett-row',
          onclick: () => {
            // Register a back-handler so swipe-back goes from subpage → list (not closing modal)
            pushBackHandler(() => { view = 'list'; render(); });
            view = sec.key;
            render();
          }
        }, [
          el('span', { class: 'sett-row-icon' }, sec.icon),
          el('span', { class: 'sett-row-body' }, [
            el('span', { class: 'sett-row-title' }, sec.title),
            el('span', { class: 'sett-row-sub' }, sec.subtitle)
          ]),
          el('span', { class: 'sett-row-arrow' }, '›')
        ]));
      });
      wrap.appendChild(list);
      wrap.appendChild(el('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:16px',
        onclick: doSave
      }, 'Save changes'));
      return;
    }

    // Subpage header — back arrow + title
    const sec = sections.find(s => s.key === view);
    wrap.appendChild(el('div', { class: 'sett-subpage-head' }, [
      el('button', {
        type: 'button', class: 'sett-back-btn',
        onclick: () => popBack(),
        'aria-label': 'Back'
      }, '←'),
      el('span', { class: 'sett-subpage-title' }, sec.icon + '  ' + sec.title)
    ]));

    const body = el('div', { class: 'sett-subpage-body' });
    if (view === 'upi') {
      body.appendChild(el('div', { class: 'field' }, [
        el('label', {}, 'UPI ID'),
        el('input', { class: 'input', id: 'as-upi-id', type: 'text', placeholder: 'admin@upi', value: pending.upiId })
      ]));
      body.appendChild(el('div', { class: 'field' }, [
        el('label', {}, 'UPI display name'),
        el('input', { class: 'input', id: 'as-upi-name', type: 'text', placeholder: 'DailyWater Admin', value: pending.upiName })
      ]));
      body.appendChild(el('div', { class: 'text-muted', style: 'font-size:12px' },
        'Owners see Pay-via-UPI + QR on the Renew screen using this UPI.'));
    } else if (view === 'plans') {
      plans.forEach(p => {
        body.appendChild(el('div', { class: 'row gap-sm', style: 'align-items:center;margin-bottom:10px' }, [
          el('span', { style: 'flex:1;font-size:14px' }, p.name + ' · ' + p.duration_days + ' days'),
          el('input', { class: 'input', id: 'plan-' + p.key, type: 'number', min: 0, value: pending.planPrices[p.key], style: 'width:120px;text-align:right' })
        ]));
      });
    } else if (view === 'theme') {
      [
        { v: 'light', l: '☀️ Light',                    h: 'Bright background, classic look' },
        { v: 'dark',  l: '🌙 Dark',                     h: 'Easier on the eyes at night' },
        { v: 'auto',  l: '⚙️ Auto · match phone',        h: 'Switches automatically with system' }
      ].forEach(opt => {
        const selected = pending.theme === opt.v;
        body.appendChild(el('button', {
          type: 'button',
          class: 'sett-radio-row' + (selected ? ' selected' : ''),
          onclick: () => { pending.theme = opt.v; setTheme(opt.v); render(); }
        }, [
          el('span', { class: 'sett-radio-text' }, [
            el('span', { class: 'sett-radio-title' }, opt.l),
            el('span', { class: 'sett-radio-sub' }, opt.h)
          ]),
          el('span', { class: 'sett-radio-tick' }, selected ? '✓' : '')
        ]));
      });
    } else if (view === 'lang') {
      [
        { v: 'en', l: 'English' },
        { v: 'hi', l: 'हिन्दी (Hindi)' },
        { v: 'mr', l: 'मराठी (Marathi)' }
      ].forEach(opt => {
        const selected = pending.lang === opt.v;
        body.appendChild(el('button', {
          type: 'button',
          class: 'sett-radio-row' + (selected ? ' selected' : ''),
          onclick: () => { pending.lang = opt.v; render(); }
        }, [
          el('span', { class: 'sett-radio-text' }, [
            el('span', { class: 'sett-radio-title' }, opt.l)
          ]),
          el('span', { class: 'sett-radio-tick' }, selected ? '✓' : '')
        ]));
      });
    }
    wrap.appendChild(body);

    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:16px',
      onclick: doSave
    }, 'Save changes'));
  }

  render();
  openModal('Settings', wrap);
}

function adminGrantSlots(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) return;
  const wrap = el('div', {});
  const currentLimit = Number(owner.customer_limit) || 10;
  let nextLimit = currentLimit;

  wrap.appendChild(el('div', { class: 'text-muted', style: 'font-size:13px;margin-bottom:10px' },
    owner.name + ' currently has a quota of ' + currentLimit + ' IDs (' + ownerCount(ownerId) + ' used). Grant more to allow them to add more customers / delivery boys.'));

  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'New ID limit'),
    el('input', {
      class: 'input', type: 'number', min: ownerCount(ownerId), value: currentLimit + 10,
      oninput: (e) => nextLimit = Math.max(0, +e.target.value || 0)
    })
  ]));
  nextLimit = currentLimit + 10;

  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:12px',
    onclick: () => {
      if (nextLimit < ownerCount(ownerId)) {
        return toast('New limit can\'t be below current usage (' + ownerCount(ownerId) + ')', 'error');
      }
      owner.customer_limit = nextLimit;
      Store.save();
      notify(owner.id, 'welcome', 'Quota updated',
        'Your ID limit is now ' + nextLimit + '. You can add more customers and delivery boys.');
      toast('Quota set to ' + nextLimit, 'success');
      closeModal();
      viewAdmin();
    }
  }, 'Save new limit'));

  openModal('Grant more IDs', wrap);
}

// Admin records a payment from an owner. Picks a plan, optionally a custom amount + note,
// and extends subscription_expires_at by plan.duration_days. If the owner's current expiry
// is in the past, the new period starts today; otherwise it stacks on top.
function adminMarkPaid(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) return;
  const wrap = el('div', {});
  const plans = getPlans().filter(p => p.active !== false);
  if (plans.length === 0) { return toast('No plans defined — add one first', 'error'); }
  let pickedKey = plans[0].key;
  let amount = plans[0].price;
  let note = '';

  wrap.appendChild(el('div', { class: 'text-muted', style: 'font-size:13px;margin-bottom:10px' },
    'Record payment received from ' + owner.name + '. Their subscription will be extended.'));

  // Plan picker
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Plan'),
    el('div', { class: 'role-toggle', id: 'mp-plan', style: 'grid-template-columns:repeat(' + plans.length + ',1fr)' },
      plans.map((p, i) => el('button', {
        type: 'button', class: i === 0 ? 'active' : '', dataset: { key: p.key, price: p.price }
      }, p.name + ' · ₹' + p.price))
    )
  ]));
  // Amount
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Amount paid (₹)'),
    el('input', { class: 'input', id: 'mp-amount', type: 'number', min: 0, value: amount,
      oninput: (e) => amount = Math.max(0, +e.target.value || 0) })
  ]));
  // Note
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Note (optional)'),
    el('input', { class: 'input', id: 'mp-note', type: 'text', placeholder: 'UPI ref / cash receipt #', oninput: (e) => note = e.target.value })
  ]));

  const amtInput = wrap.querySelector('#mp-amount');
  wrap.querySelectorAll('#mp-plan button').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('#mp-plan button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pickedKey = btn.dataset.key;
      amount = +btn.dataset.price || 0;
      if (amtInput) amtInput.value = amount;
    });
  });

  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:12px',
    onclick: () => {
      const plan = getPlanByKey(pickedKey);
      if (!plan) return toast('Pick a plan', 'error');
      const now = new Date();
      const currentExp = owner.subscription_expires_at ? new Date(owner.subscription_expires_at) : now;
      // If currently expired, start new period from today; otherwise stack.
      const baseDate = currentExp.getTime() > now.getTime() ? currentExp : now;
      const newExp = new Date(baseDate.getTime() + plan.duration_days * 86400000);
      owner.subscription_plan = plan.key;
      owner.subscription_started_at = now.toISOString();
      owner.subscription_expires_at = newExp.toISOString();
      // Append payment record (audit trail)
      Store.data.subscriptionPayments = Store.data.subscriptionPayments || [];
      Store.data.subscriptionPayments.push({
        id: uid(), ownerId: owner.id, plan_key: plan.key,
        amount_paid: amount, paid_at: now.toISOString(),
        expires_at: newExp.toISOString(), marked_by_admin_id: App.user.id, note: note || ''
      });
      Store.save();
      notify(owner.id, 'payment', 'Payment received — subscription extended',
        plan.name + ' (₹' + amount + ') · valid until ' + prettyDate(newExp.toISOString().slice(0, 10)) + '. Thank you!');
      toast('Marked paid · valid until ' + prettyDate(newExp.toISOString().slice(0, 10)), 'success');
      closeModal();
      viewAdmin();
    }
  }, 'Record payment'));

  openModal('Mark as paid', wrap);
}

// Admin drill-down: list a single owner's customers
function adminOwnerCustomers(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) return;
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  $view.appendChild(topbar({
    title: owner.name + ' — customers',
    subtitle: 'Admin view',
    back: () => viewAdmin()
  }));

  const page = el('div', { class: 'page' });
  const customers = Store.data.users.filter(u => u.role === 'customer' && u.ownerId === ownerId);
  const boys = Store.data.users.filter(u => u.role === 'delivery_boy' && u.ownerId === ownerId);

  page.appendChild(el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Customers'),
      el('div', { class: 'stat-value' }, String(customers.length))
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Delivery boys'),
      el('div', { class: 'stat-value' }, String(boys.length))
    ])
  ]));

  if (customers.length === 0 && boys.length === 0) {
    page.appendChild(emptyState('👥', 'No users yet', 'This account hasn\'t added any customers or delivery boys.'));
  }

  if (customers.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [el('h2', {}, 'Customers')]));
    const list = el('div', { class: 'list' });
    customers.forEach(c => {
      list.appendChild(el('div', { class: 'list-item' }, [
        avatarFor(c),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, c.name),
          el('div', { class: 'li-sub' }, '+91 ' + c.mobile + ' · ' + (c.address || 'no address'))
        ]),
        el('span', { class: 'badge info' }, c.plan || fmtQty(c.dailyMl || 0))
      ]));
    });
    page.appendChild(list);
  }

  if (boys.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [el('h2', {}, 'Delivery boys')]));
    const list = el('div', { class: 'list' });
    boys.forEach(b => {
      const assignedCount = Store.data.users.filter(u => u.role === 'customer' && u.assignedBoyId === b.id).length;
      list.appendChild(el('div', { class: 'list-item' }, [
        avatarFor(b),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, b.name),
          el('div', { class: 'li-sub' }, '+91 ' + b.mobile + ' · ' + assignedCount + ' assigned')
        ])
      ]));
    });
    page.appendChild(list);
  }

  $view.appendChild(page);
}

// Hard-delete an owner and EVERYTHING they own. Two-step confirmation.
function adminDeleteOwnerConfirm(ownerId) {
  const owner = getOwnerById(ownerId);
  if (!owner) return;
  const customers = Store.data.users.filter(u => u.role === 'customer' && u.ownerId === ownerId).length;
  const boys = Store.data.users.filter(u => u.role === 'delivery_boy' && u.ownerId === ownerId).length;
  const wrap = el('div', {});
  wrap.appendChild(el('div', { style: 'text-align:center;font-size:48px' }, '⚠️'));
  wrap.appendChild(el('div', { style: 'text-align:center;font-weight:700;font-size:16px;margin-top:6px' }, 'Hard-delete this owner?'));
  wrap.appendChild(el('div', { class: 'text-muted', style: 'font-size:13px;text-align:center;margin:8px 14px 14px' },
    'This will permanently remove ' + owner.name + ' and ALL their data: ' +
    customers + ' customers, ' + boys + ' delivery boys, all deliveries, payments, products, ratings, and settings. ' +
    'This cannot be undone.'));
  let typed = '';
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Type DELETE to confirm'),
    el('input', { class: 'input', placeholder: 'DELETE', autofocus: true, oninput: (e) => typed = e.target.value })
  ]));
  wrap.appendChild(el('button', {
    class: 'btn btn-danger btn-block', style: 'margin-top:8px',
    onclick: async () => {
      if (typed !== 'DELETE') return toast('Type DELETE in caps to confirm', 'error');
      await adminDeleteOwner(ownerId);
      toast('Owner and all data deleted', 'success');
      closeModal();
      viewAdmin();
    }
  }, 'Permanently delete'));
  wrap.appendChild(el('button', {
    class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
    onclick: () => closeModal()
  }, 'Cancel'));
  openModal('Delete owner', wrap);
}

async function adminDeleteOwner(ownerId) {
  const ownedUsers = Store.data.users.filter(u => u.ownerId === ownerId);
  const ownedUserIds = ownedUsers.map(u => u.id);

  // Collect ids of all per-record rows to delete remotely
  const delIds   = Store.data.deliveries.filter(d => d.ownerId === ownerId).map(d => d.id);
  const pauseIds = Store.data.pauses.filter(p => p.ownerId === ownerId).map(p => p.id);
  const extraIds = Store.data.extraOrders.filter(o => o.ownerId === ownerId).map(o => o.id);
  const payIds   = Store.data.payments.filter(p => p.ownerId === ownerId).map(p => p.id);
  const notifIds = Store.data.notifications.filter(n => n.ownerId === ownerId || ownedUserIds.includes(n.userId)).map(n => n.id);
  const ratingIds = (Store.data.productRatings || []).filter(r => r.ownerId === ownerId).map(r => r.id);
  const subPayIds = (Store.data.subscriptionPayments || []).filter(p => p.ownerId === ownerId).map(p => p.id);

  // Local cleanup
  Store.data.users         = Store.data.users.filter(u => u.id !== ownerId && u.ownerId !== ownerId);
  Store.data.deliveries    = Store.data.deliveries.filter(d => d.ownerId !== ownerId);
  Store.data.pauses        = Store.data.pauses.filter(p => p.ownerId !== ownerId);
  Store.data.extraOrders   = Store.data.extraOrders.filter(o => o.ownerId !== ownerId);
  Store.data.payments      = Store.data.payments.filter(p => p.ownerId !== ownerId);
  Store.data.notifications = Store.data.notifications.filter(n => n.ownerId !== ownerId && !ownedUserIds.includes(n.userId));
  Store.data.productRatings = (Store.data.productRatings || []).filter(r => r.ownerId !== ownerId);
  Store.data.subscriptionPayments = (Store.data.subscriptionPayments || []).filter(p => p.ownerId !== ownerId);
  if (Store.data.dairySettings) delete Store.data.dairySettings[ownerId];
  Store.save();

  await Promise.all([
    Store.removeRemote('users', [ownerId, ...ownedUserIds]),
    Store.removeRemote('deliveries', delIds),
    Store.removeRemote('pauses', pauseIds),
    Store.removeRemote('extra_orders', extraIds),
    Store.removeRemote('payments', payIds),
    Store.removeRemote('notifications', notifIds),
    Store.removeRemote('holidays', [ownerId], 'ownerId'),
    Store.removeRemote('products', [ownerId], 'ownerId'),
    Store.removeRemote('product_ratings', ratingIds),
    Store.removeRemote('subscription_payments', subPayIds),
    Store.removeRemote('dairy_settings', [ownerId], 'ownerId')
  ]);
}

// Subscription banner shown on owner home. Returns null for unlimited owners (no banner needed).
function renderOwnerSubscriptionCard() {
  if (!App.user || App.user.role !== 'owner') return null;
  const exp = ownerExpiryInfo(App.user);
  if (exp.state === 'unlimited') return null;
  const planLabel = exp.plan === 'trial' ? 'Free trial' : (getPlanByKey(exp.plan)?.name || (exp.plan || 'No plan'));

  let bgClass, label, sub;
  if (exp.state === 'active' && exp.daysLeft > 7) {
    bgClass = 'sub-card sub-ok';
    label = exp.daysLeft + ' days left';
    sub = planLabel + ' · expires ' + prettyDate(String(exp.expiresAt).slice(0, 10));
  } else if (exp.state === 'active') {
    bgClass = 'sub-card sub-warn';
    label = '⚠ Only ' + exp.daysLeft + ' day' + (exp.daysLeft === 1 ? '' : 's') + ' left';
    sub = planLabel + ' · renew before ' + prettyDate(String(exp.expiresAt).slice(0, 10));
  } else if (exp.state === 'grace') {
    bgClass = 'sub-card sub-grace';
    label = '⚠ EXPIRED · grace period';
    sub = 'Service stops in ' + (GRACE_DAYS + exp.daysLeft) + ' day' + ((GRACE_DAYS + exp.daysLeft) === 1 ? '' : 's') + ' — renew now';
  } else {
    bgClass = 'sub-card sub-expired';
    label = '⛔ EXPIRED';
    sub = 'Customers and delivery boys are locked out — renew immediately';
  }

  return el('div', { class: bgClass, style: 'margin:10px 14px 4px;padding:14px;border-radius:14px' }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' }, [
      el('div', {}, [
        el('div', { style: 'font-weight:800;font-size:15px' }, label),
        el('div', { style: 'font-size:12px;opacity:.85;margin-top:2px' }, sub)
      ]),
      el('button', {
        class: 'btn btn-sm btn-light',
        onclick: () => openRenewModal()
      }, exp.state === 'active' ? 'Renew' : 'Renew now')
    ])
  ]);
}

// Build a plan-renewal card with UPI + WhatsApp pay actions, used by openRenewModal and viewOwnerLocked.
function renewalPlanCard(p) {
  const card = el('div', { class: 'card', style: 'margin-top:10px;padding:14px;border:1px solid var(--line)' }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
      el('div', {}, [
        el('div', { style: 'font-weight:700;font-size:16px' }, p.name),
        el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:2px' }, p.duration_days + ' days of service')
      ]),
      el('div', { style: 'font-family:var(--font-mono);font-weight:800;font-size:20px;color:var(--primary-deep)' }, '₹' + p.price)
    ])
  ]);

  const noteForAdmin =
    'DailyWater ' + p.name + ' renewal · ' + App.user.name + ' (+91 ' + App.user.mobile + ')';
  const waMessage =
    'Hi admin, I want to renew my DailyWater account.\n\n' +
    'Owner: ' + App.user.name + '\n' +
    'Mobile: +91 ' + App.user.mobile + '\n' +
    'Dairy ID: ' + App.user.id + '\n' +
    'Plan: ' + p.name + ' (₹' + p.price + ' for ' + p.duration_days + ' days)';

  const upiUrl = adminUpiDeepLink(p.price, noteForAdmin);
  const adminUpi = adminUpiSettings();
  if (upiUrl) {
    card.appendChild(el('a', {
      class: 'btn btn-primary btn-block', style: 'margin-top:10px',
      href: upiUrl
    }, '💳 Pay ₹' + p.price + ' via UPI'));
    // QR + admin UPI details shown by default, so owner can scan from another phone
    // or copy the UPI ID even if the deep link doesn't open a UPI app on this device.
    const qrSection = el('div', {
      style: 'margin-top:12px;text-align:center;padding:14px;background:#FAFAF7;border:1px dashed var(--line);border-radius:10px'
    });
    const img = makeQRImage(upiUrl);
    if (img) {
      img.style.maxWidth = '180px';
      img.style.display = 'block';
      img.style.margin = '0 auto';
      img.alt = 'UPI QR for ₹' + p.price;
      qrSection.appendChild(img);
    } else {
      qrSection.appendChild(el('div', { class: 'text-muted', style: 'font-size:12px' }, 'QR unavailable on this device'));
    }
    qrSection.appendChild(el('div', { class: 'text-muted', style: 'font-size:11px;margin-top:8px' }, 'Scan with any UPI app to pay ₹' + p.price));
    qrSection.appendChild(el('div', { style: 'font-family:var(--font-mono);font-size:14px;font-weight:700;margin-top:8px;color:var(--primary-deep)' }, adminUpi.upiId));
    if (adminUpi.upiName) {
      qrSection.appendChild(el('div', { class: 'text-muted', style: 'font-size:11px' }, adminUpi.upiName));
    }
    // Copy UPI ID button (handy when QR scan fails)
    qrSection.appendChild(el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', style: 'margin-top:8px;font-size:12px',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(adminUpi.upiId);
          toast('UPI ID copied', 'success');
        } catch (e) { toast(adminUpi.upiId, 'success'); }
      }
    }, '📋 Copy UPI ID'));
    card.appendChild(qrSection);
  }
  card.appendChild(el('a', {
    class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
    href: waLink(ADMIN_WA_NUMBER, waMessage + (upiUrl ? '\n\nPaid via UPI — please mark as paid.' : '\n\nPlease share UPI / bank details to pay.')),
    target: '_blank', rel: 'noopener'
  }, '💬 WhatsApp admin'));

  return card;
}

// Render plan picker (dropdown) + single re-rendering card. Returns the wrapper element.
// Used by both openRenewModal and viewOwnerLocked.
function buildPlanPicker(host, plans) {
  let selectedKey = plans[0].key;
  host.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Plan'),
    el('select', {
      class: 'select', id: 'renew-plan-select',
      onchange: (e) => { selectedKey = e.target.value; renderCard(); }
    }, plans.map(p => el('option', { value: p.key },
      p.name + ' · ₹' + p.price + ' · ' + p.duration_days + ' days'
    )))
  ]));
  const cardHost = el('div', {});
  host.appendChild(cardHost);
  const renderCard = () => {
    clear(cardHost);
    const plan = plans.find(p => p.key === selectedKey);
    if (plan) cardHost.appendChild(renewalPlanCard(plan));
  };
  renderCard();
}

// Plans modal — owner picks a plan from a dropdown, the card below shows price + pay actions.
function openRenewModal() {
  const wrap = el('div', {});
  const exp = ownerExpiryInfo(App.user);
  const adminUpi = adminUpiSettings();
  wrap.appendChild(el('div', { class: 'text-muted', style: 'font-size:13px;margin-bottom:10px' },
    (exp.state === 'expired' ? 'Your service is expired. ' : '') +
    (adminUpi?.upiId
      ? 'Pick a plan and pay admin via UPI. After payment, message them so they mark your renewal complete.'
      : 'Pick a plan and message admin via WhatsApp to pay.')));
  const plans = getPlans().filter(p => p.active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (plans.length === 0) {
    wrap.appendChild(el('div', { class: 'card text-muted' }, 'No plans available — please contact admin.'));
  } else {
    buildPlanPicker(wrap, plans);
  }
  wrap.appendChild(el('div', { class: 'text-muted', style: 'font-size:11px;margin-top:14px;text-align:center' },
    'After payment, admin will mark your account as paid and you can resume.'));
  openModal('Renew subscription', wrap);
}

function viewOwner() {
  const tabs = [
    { key: 'home',      label: t('home'),      icon: 'home' },
    { key: 'customers', label: t('customers'), icon: 'users' },
    { key: 'today',     label: t('today'),     icon: 'truck' },
    { key: 'bills',     label: t('bills'),     icon: 'bill' },
    { key: 'reports',   label: t('reports'),   icon: 'chart' }
  ];
  buildTabbar(tabs, App.ownerTab, (k) => { App.ownerTab = k; viewOwner(); });
  $waBtn.hidden = true;
  clear($view);

  switch (App.ownerTab) {
    case 'home':      ownerHome(); break;
    case 'customers': ownerCustomers(); break;
    case 'today':     ownerToday(); break;
    case 'bills':     ownerBills(); break;
    case 'reports':   ownerReports(); break;
  }
}

function ownerHome() {
  $view.appendChild(topbar({
    title: 'Hi, ' + App.user.name.split(' ')[0], subtitle: 'Owner dashboard',
    bell: true, logout: true,
    right: el('button', { class: 'icon-btn', onclick: () => openOwnerSettings(), 'aria-label': 'Settings', html: ICON.settings })
  }));

  // Subscription card — countdown + status + renew button
  const subCard = renderOwnerSubscriptionCard();
  if (subCard) $view.appendChild(subCard);

  const today = todayISO();
  const customers = getCustomers();
  const todayDeliveries = Store.data.deliveries.filter(d => d.date === today && d.status === 'delivered');
  const todayMl = todayDeliveries.reduce((s, d) => s + d.ml, 0);
  const month = monthKey();
  const monthDeliveries = Store.data.deliveries.filter(d => d.date.startsWith(month) && d.status === 'delivered');
  const monthRev = customers.reduce((s, c) => s + customerMonthBill(c.id, month).total, 0);
  const pendingPayments = customers.reduce((s, c) => s + customerMonthBill(c.id, month).due, 0);

  const page = el('div', { class: 'page' });

  // Stats grid (clickable)
  const mkStat = (kind, label, value, valueStyle) => el('button', {
    class: 'stat is-clickable', type: 'button', onclick: () => ownerStatDetail(kind)
  }, [
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value', style: valueStyle || '' }, value)
  ]);
  page.appendChild(el('div', { class: 'stat-grid' }, [
    mkStat('today', 'Today delivered', fmtQty(todayMl)),
    mkStat('customers', 'Active customers', String(customers.length)),
    mkStat('revenue', 'Month revenue', fmtMoney(monthRev)),
    mkStat('dues', 'Pending dues', fmtMoney(pendingPayments), pendingPayments > 0 ? 'color:var(--warning)' : '')
  ]));

  // Tomorrow's procurement card
  const tomDate = new Date(); tomDate.setDate(tomDate.getDate() + 1);
  const tomISO = tomDate.toISOString().slice(0, 10);
  const tomHoliday = getHoliday(tomISO);
  const tomActive = customers.filter(c => !isPaused(c.id, tomISO) && isDeliveryDue(c, tomISO));
  const tomMl = tomHoliday ? 0 : tomActive.reduce((s, c) => s + (c.dailyMl || 0), 0);
  page.appendChild(el('div', { class: 'card', style: 'margin-top:14px;cursor:pointer;background:linear-gradient(135deg,var(--surface),var(--primary-soft))', onclick: () => ownerProcurementDetail() }, [
    el('div', { class: 'row gap-md', style: 'align-items:center' }, [
      el('div', { class: 'li-avatar', style: 'background:var(--primary);color:#fff;font-size:18px' }, '📦'),
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-weight:700' }, 'Tomorrow needs ' + (tomHoliday ? '— holiday' : fmtQty(tomMl))),
        el('div', { class: 'text-muted', style: 'font-size:13px' },
          tomHoliday ? tomHoliday.label : (tomActive.length + ' customer' + (tomActive.length === 1 ? '' : 's') + (customers.length - tomActive.length > 0 ? ' · ' + (customers.length - tomActive.length) + ' paused' : '')))
      ]),
      el('span', { class: 'link-btn' }, 'Plan →')
    ])
  ]));

  // Pending orders card
  const pendingOrders = Store.data.extraOrders.filter(o => o.status === 'pending' || o.status === 'confirmed');
  if (pendingOrders.length) {
    const pendingCount = pendingOrders.filter(o => o.status === 'pending').length;
    page.appendChild(el('div', { class: 'card', style: 'margin-top:14px;cursor:pointer', onclick: () => ownerOrdersInbox() }, [
      el('div', { class: 'row gap-md', style: 'align-items:center' }, [
        el('div', { class: 'li-avatar', style: 'background:var(--primary);color:#fff' }, '🛒'),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:700' }, pendingOrders.length + ' active extra order' + (pendingOrders.length > 1 ? 's' : '')),
          el('div', { class: 'text-muted', style: 'font-size:13px' }, pendingCount + ' awaiting confirmation')
        ]),
        el('span', { class: 'link-btn' }, 'Review →')
      ])
    ]));
  }

  // Quick actions
  page.appendChild(el('div', { class: 'section-head' }, [el('h2', {}, 'Quick actions')]));
  page.appendChild(el('div', { class: 'quick-grid' }, [
    el('button', { class: 'quick-tile', onclick: () => { App.ownerTab = 'customers'; viewOwner(); } }, [
      el('span', { class: 'icon', html: ICON.plus }),
      el('span', {}, 'Add customer')
    ]),
    el('button', { class: 'quick-tile', onclick: () => { App.ownerTab = 'today'; viewOwner(); } }, [
      el('span', { class: 'icon', html: ICON.truck }),
      el('span', {}, 'Mark delivery')
    ]),
    el('button', { class: 'quick-tile', onclick: () => { App.ownerTab = 'bills'; viewOwner(); } }, [
      el('span', { class: 'icon', html: ICON.bill }),
      el('span', {}, 'Bills')
    ]),
    el('button', { class: 'quick-tile', onclick: () => ownerOrdersInbox() }, [
      el('span', { class: 'icon', html: ICON.bag }),
      el('span', {}, 'Orders')
    ])
  ]));

  // Today progress + all customers with status
  const withStatus = customers.map(c => {
    const paused = isPaused(c.id, today);
    const row = getDelivery(c.id, today);
    return { c, paused, status: paused ? 'paused' : (row?.status || 'pending') };
  });
  const totalActive = withStatus.filter(x => !x.paused).length;
  const homeDelivered = withStatus.filter(x => x.status === 'delivered').length;
  const homeSkipped = withStatus.filter(x => x.status === 'skipped').length;

  page.appendChild(el('div', { class: 'section-head' }, [
    el('h2', {}, 'Today (' + (homeDelivered + homeSkipped) + '/' + totalActive + ')'),
    el('button', { class: 'link-btn', onclick: () => { App.ownerTab = 'today'; viewOwner(); } }, 'Mark deliveries →')
  ]));
  if (totalActive > 0) {
    page.appendChild(el('div', { class: 'progress-track', style: 'margin-bottom:10px' }, [
      el('div', { class: 'progress-fill', style: 'width:' + Math.round(((homeDelivered + homeSkipped) / totalActive) * 100) + '%' })
    ]));
  }
  const list = el('div', { class: 'list' });
  if (customers.length === 0) {
    list.appendChild(emptyState('👥', 'No customers yet', 'Add your first customer to begin.'));
  } else {
    withStatus.forEach(({ c }) => list.appendChild(customerLineForDelivery(c, today)));
  }
  page.appendChild(list);

  $view.appendChild(page);
}

function customerLineForDelivery(c, date) {
  const status = (() => {
    if (isPaused(c.id, date)) return { cls: 'badge muted', text: 'Paused' };
    const row = getDelivery(c.id, date);
    if (!row || row.status === 'pending') return { cls: 'badge warn', text: 'Pending' };
    if (row.status === 'delivered') return { cls: 'badge success', text: 'Delivered' };
    return { cls: 'badge danger', text: 'Skipped' };
  })();
  return el('div', { class: 'list-item' }, [
    avatarFor(c),
    el('div', { class: 'li-body' }, [
      el('div', { class: 'li-title' }, c.name),
      el('div', { class: 'li-sub' }, c.plan + ' · ' + fmtQty(c.dailyMl))
    ]),
    el('span', { class: status.cls }, status.text)
  ]);
}

function emptyState(emoji, title, body) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-icon' }, emoji),
    el('div', { class: 'empty-title' }, title),
    el('div', {}, body || '')
  ]);
}

/* ── Owner: customers ─────────────────────────────────────── */
function ownerCustomers() {
  clear($view);
  const customers = getCustomers();
  $view.appendChild(topbar({
    title: 'Customers', subtitle: customers.length + ' active', bell: true,
    right: el('button', { class: 'icon-btn', onclick: () => customerForm(null), 'aria-label': 'Add customer', html: ICON.plus })
  }));
  const page = el('div', { class: 'page' });
  if (customers.length === 0) {
    page.appendChild(emptyState('👥', 'No customers yet', 'Tap + to add your first customer.'));
    $view.appendChild(page);
    return;
  }

  if (!App.customerView) App.customerView = { search: '', sort: 'name' };
  const v = App.customerView;
  const month = monthKey();

  // Search + sort row
  const searchInput = el('input', {
    class: 'input', type: 'search', placeholder: '🔍 Search by name or mobile…', value: v.search,
    oninput: (e) => { v.search = e.target.value; ownerCustomers(); }
  });
  const sortSelect = el('select', {
    class: 'select', style: 'max-width:140px',
    onchange: (e) => { v.sort = e.target.value; ownerCustomers(); }
  }, [
    el('option', { value: 'name', selected: v.sort === 'name' }, 'Sort: Name'),
    el('option', { value: 'due', selected: v.sort === 'due' }, 'Sort: Due'),
    el('option', { value: 'volume', selected: v.sort === 'volume' }, 'Sort: Volume')
  ]);
  page.appendChild(el('div', { class: 'row gap-sm', style: 'margin-bottom:12px' }, [searchInput, sortSelect]));

  // Apply search
  const q = v.search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  let filtered = customers;
  if (q) filtered = customers.filter(c =>
    c.name.toLowerCase().includes(q) || (qDigits && c.mobile.includes(qDigits))
  );

  // Apply sort
  const enriched = filtered.map(c => ({ c, b: customerMonthBill(c.id, month) }));
  if (v.sort === 'due')    enriched.sort((a, b) => b.b.due - a.b.due);
  if (v.sort === 'volume') enriched.sort((a, b) => b.c.dailyMl - a.c.dailyMl);
  if (v.sort === 'name')   enriched.sort((a, b) => a.c.name.localeCompare(b.c.name));

  if (enriched.length === 0) {
    page.appendChild(emptyState('🔍', 'No matches', 'No customers matched "' + v.search + '".'));
  } else {
    const list = el('div', { class: 'list' });
    enriched.forEach(({ c, b }) => {
      const isOnline = Store.Presence && Store.Presence.has(c.id);
      const avatarWrap = el('div', {
        class: 'avatar-online-wrap' + (isOnline ? ' is-online' : ''),
        'data-user-id': c.id
      }, [avatarFor(c)]);
      const item = el('button', { class: 'list-item', style: 'text-align:left;border:1px solid var(--line);background:var(--surface);width:100%', onclick: () => customerDetail(c.id) }, [
        avatarWrap,
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, [c.name, el('span', { class: 'presence-inline' + (isOnline ? '' : ' is-offline'), 'data-user-id': c.id }, ' · online')]),
          el('div', { class: 'li-sub' }, '+91 ' + c.mobile + ' · ' + fmtQty(c.dailyMl))
        ]),
        el('div', { class: 'li-aside', style: 'text-align:right' }, [
          b.due > 0
            ? el('div', { class: 'amount', style: 'color:var(--warning);font-size:13px' }, fmtMoney(b.due) + ' due')
            : el('div', { style: 'color:var(--text-muted);font-size:12px' }, 'Settled'),
          el('div', { class: 'text-mono', style: 'color:var(--text-muted);font-size:11px;margin-top:2px' }, c.address ? c.address.slice(0, 14) + (c.address.length > 14 ? '…' : '') : '')
        ])
      ]);
      list.appendChild(item);
    });
    page.appendChild(list);
  }
  $view.appendChild(page);
}

function avatarFor(user, size) {
  const sz = size || 44;
  const onClick = user && user.photo
    ? (ev) => { ev.stopPropagation(); ev.preventDefault(); openPhotoLightbox(user.photo, user.name); }
    : null;
  if (user && user.photo) {
    return el('div', {
      class: 'li-avatar avatar-photo is-tappable',
      style: 'width:' + sz + 'px;height:' + sz + 'px;background-image:url(' + user.photo + ')',
      onclick: onClick, role: 'button', 'aria-label': 'View ' + (user.name || 'profile') + ' photo'
    });
  }
  return el('div', { class: 'li-avatar', style: 'width:' + sz + 'px;height:' + sz + 'px' }, (user?.name?.[0] || '?').toUpperCase());
}

// Fullscreen photo lightbox — tap anywhere or press Esc to close
function openPhotoLightbox(src, caption) {
  if (!src) return;
  const existing = document.getElementById('photoLightbox');
  if (existing) existing.remove();
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const img = el('img', { src, alt: caption || 'photo', class: 'lb-img' });
  const cap = caption ? el('div', { class: 'lb-caption' }, caption) : null;
  const box = el('div', { id: 'photoLightbox', class: 'photo-lightbox', onclick: close },
    cap ? [img, cap] : [img]);
  document.body.appendChild(box);
  document.addEventListener('keydown', onKey);
}

// Bottle/jar sizes (ml) offered across the app — edit to match your inventory.
const BOTTLE_SIZES_ML = [250, 500, 1000, 2000, 5000, 20000];
// Jar/deposit tracking writes jars_held + jar_deposit columns. Keep false until the
// ALTER TABLE migration has run, then flip to true — otherwise user upserts fail.
const JARS_ENABLED = false;
function customerForm(existing) {
  const isEdit = !!existing;
  // Quota check — block new customers if owner has hit their limit. Edits are allowed.
  if (!isEdit && App.user && App.user.role === 'owner') {
    if (ownerAtQuota(App.user.id)) {
      return showQuotaReachedModal('customer');
    }
  }
  const wrap = el('div', {});

  // Photo picker
  let photoData = existing?.photo || null;
  const photoBox = el('div', { class: 'avatar-picker' });
  const renderPhoto = () => {
    photoBox.innerHTML = '';
    if (photoData) {
      photoBox.appendChild(el('div', { class: 'avatar-photo avatar-large', style: 'background-image:url(' + photoData + ')' }));
    } else {
      photoBox.appendChild(el('div', { class: 'avatar-large' }, (document.getElementById('cf-name')?.value || '?')[0].toUpperCase()));
    }
    const pickBtn = el('button', {
      class: 'btn btn-sm btn-ghost', type: 'button', style: 'margin-top:8px',
      onclick: async () => {
        const pic = await capturePhoto();
        if (pic) { photoData = pic; renderPhoto(); }
      }
    }, photoData ? '✏️ Change photo' : '📷 Add photo');
    photoBox.appendChild(pickBtn);
    if (photoData) {
      photoBox.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', style: 'margin-top:8px;margin-left:8px;color:var(--danger)',
        onclick: () => { photoData = null; renderPhoto(); }
      }, 'Remove'));
    }
  };
  renderPhoto();
  wrap.appendChild(photoBox);

  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Full name'),
    el('input', { class: 'input', id: 'cf-name', type: 'text', value: existing?.name || '', autofocus: true,
      oninput: () => { if (!photoData) renderPhoto(); } })
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Mobile (10 digits)'),
    el('input', { class: 'input', id: 'cf-mobile', type: 'tel', inputmode: 'numeric', maxlength: 10, value: existing?.mobile || '' })
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Address'),
    el('input', { class: 'input', id: 'cf-addr', type: 'text', value: existing?.address || '' })
  ]));
  const BOTTLE_SIZES = BOTTLE_SIZES_ML;
  // Derive the saved size + count from an existing customer's dailyMl
  // (largest configured size that divides it evenly; otherwise treat it as a one-off size).
  let curSize = BOTTLE_SIZES[0], curCount = 1;
  if (existing?.dailyMl) {
    const match = [...BOTTLE_SIZES].sort((a,b) => b - a).find(s => existing.dailyMl % s === 0);
    if (match) { curSize = match; curCount = existing.dailyMl / match; }
    else { curSize = existing.dailyMl; curCount = 1; }
  }
  const sizeList = BOTTLE_SIZES.includes(curSize) ? BOTTLE_SIZES : [curSize, ...BOTTLE_SIZES];
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Bottle size'),
    el('select', { class: 'select', id: 'cf-size' }, sizeList.map(s =>
      el('option', { value: s, selected: s === curSize }, fmtQty(s) + ' bottle')))
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Bottles per delivery'),
    el('select', { class: 'select', id: 'cf-count' }, [1,2,3,4,5,6,7,8,9,10].map(n =>
      el('option', { value: n, selected: n === curCount }, String(n))))
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Delivery frequency'),
    el('select', { class: 'select', id: 'cf-freq' }, [
      { v: 'daily',     l: 'Daily (every day)' },
      { v: 'alternate', l: 'Alternate days (every 2 days)' },
      { v: 'weekly',    l: 'Weekly (once a week)' },
      { v: 'monthly',   l: 'Monthly (once a month)' }
    ].map(o => el('option', {
      value: o.v,
      selected: (existing?.frequency || 'daily') === o.v
    }, o.l)))
  ]));
  const formBoys = Store.data.users.filter(u => u.role === 'delivery_boy' && u.ownerId === (App.user && App.user.role === 'owner' ? App.user.id : existing?.ownerId));
  if (formBoys.length) {
    wrap.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Delivery boy'),
      el('select', { class: 'select', id: 'cf-boy' },
        [el('option', { value: '', selected: !existing?.assignedBoyId }, 'Unassigned')]
          .concat(formBoys.map(b => el('option', { value: b.id, selected: existing?.assignedBoyId === b.id }, b.name))))
    ]));
  }
  if (JARS_ENABLED) wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Jar / bottle deposit collected (₹)'),
    el('input', { class: 'input', id: 'cf-deposit', type: 'number', inputmode: 'numeric', min: '0', value: existing?.jar_deposit || 0 })
  ]));
  wrap.appendChild(el('button', { class: 'btn btn-primary btn-block', onclick: () => save() }, isEdit ? 'Save changes' : 'Add customer'));
  if (isEdit) {
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:10px',
      onclick: async () => {
        if (!await confirmDialog('Reset password?',
          'Clear ' + existing.name + '\'s password? They\'ll be asked to set a new one on next login.',
          'Reset')) return;
        existing.password_hash = null;
        Store.save();
        toast('Password reset — customer will set a new one on next login');
      }
    }, existing.password_hash ? '🔑 Reset password' : '🔑 No password set'));
    wrap.appendChild(el('button', {
      class: 'btn btn-danger btn-block', style: 'margin-top:10px',
      onclick: async () => {
        if (!await confirmDialog('Delete customer?', 'This removes ' + existing.name + ' and their delivery history.', 'Delete')) return;
        const cid = existing.id;
        const delIds   = Store.data.deliveries.filter(d => d.customerId === cid).map(d => d.id);
        const pauseIds = Store.data.pauses.filter(p => p.customerId === cid).map(p => p.id);
        const extraIds = Store.data.extraOrders.filter(o => o.customerId === cid).map(o => o.id);
        const payIds   = Store.data.payments.filter(p => p.customerId === cid).map(p => p.id);
        const notifIds = Store.data.notifications.filter(n => n.userId === cid).map(n => n.id);
        const ratingIds = (Store.data.productRatings || []).filter(r => r.customerId === cid).map(r => r.id);
        Store.data.users         = Store.data.users.filter(u => u.id !== cid);
        Store.data.deliveries    = Store.data.deliveries.filter(d => d.customerId !== cid);
        Store.data.pauses        = Store.data.pauses.filter(p => p.customerId !== cid);
        Store.data.extraOrders   = Store.data.extraOrders.filter(o => o.customerId !== cid);
        Store.data.payments      = Store.data.payments.filter(p => p.customerId !== cid);
        Store.data.notifications = Store.data.notifications.filter(n => n.userId !== cid);
        Store.data.productRatings = (Store.data.productRatings || []).filter(r => r.customerId !== cid);
        Store.save();
        await Promise.all([
          Store.removeRemote('users', cid),
          Store.removeRemote('deliveries', delIds),
          Store.removeRemote('pauses', pauseIds),
          Store.removeRemote('extra_orders', extraIds),
          Store.removeRemote('payments', payIds),
          Store.removeRemote('notifications', notifIds),
          Store.removeRemote('product_ratings', ratingIds)
        ]);
        toast('Customer deleted');
        viewOwner();
      }
    }, 'Delete customer'));
  }

  function save() {
    const name = document.getElementById('cf-name').value.trim();
    const mobile = document.getElementById('cf-mobile').value.replace(/\D/g, '');
    const addr = document.getElementById('cf-addr').value.trim();
    const size = +document.getElementById('cf-size').value;
    const count = +document.getElementById('cf-count').value || 1;
    const qty = size * count;
    const freq = document.getElementById('cf-freq').value || 'daily';
    const deposit = +((document.getElementById('cf-deposit') || {}).value) || 0;
    const boyId = (document.getElementById('cf-boy') || {}).value || null;
    if (!name) return toast('Enter name', 'error');
    if (mobile.length !== 10) return toast('Enter 10-digit mobile', 'error');
    // Mobile must be globally unique (one customer record per phone across all dairies)
    const conflict = Store.data.users.find(u => u.mobile === mobile && u.id !== existing?.id);
    if (conflict) return toast('That mobile is already used by another account', 'error');
    const planLabel = ({ daily: 'Daily', alternate: 'Alternate', weekly: 'Weekly', monthly: 'Monthly' })[freq] + ' ' + (count > 1 ? count + ' × ' : '') + fmtQty(size);
    if (existing) {
      Object.assign(existing, { name, mobile, address: addr, dailyMl: qty, frequency: freq, plan: planLabel, photo: photoData || null, jar_deposit: deposit, assignedBoyId: boyId });
    } else {
      // Stamp ownerId so the new customer belongs to the current dairy.
      // created_at is the anchor for non-daily frequency calculations — set locally so isDeliveryDue
      // works before the next Supabase round-trip.
      const ownerId = App.user && App.user.role === 'owner' ? App.user.id : null;
      Store.data.users.push({
        id: uid(), name, mobile, address: addr, dailyMl: qty, frequency: freq, plan: planLabel,
        role: 'customer', photo: photoData || null, ownerId, assignedBoyId: boyId,
        jar_deposit: deposit, jars_held: 0,
        created_at: new Date().toISOString()
      });
    }
    Store.save();
    toast(existing ? 'Customer updated' : 'Customer added', 'success');
    closeModal();
    viewOwner();
  }

  openModal(isEdit ? 'Edit customer' : 'Add customer', wrap);
}

function boyForm(existing) {
  const isEdit = !!existing;
  // Quota check on new boy creation
  if (!isEdit && App.user && App.user.role === 'owner') {
    if (ownerAtQuota(App.user.id)) {
      return showQuotaReachedModal('delivery_boy');
    }
  }
  const wrap = el('div', {});
  let photoData = existing?.photo || null;

  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Full name'),
    el('input', { class: 'input', id: 'bf-name', type: 'text', value: existing?.name || '', autofocus: true })
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Mobile (10 digits)'),
    el('input', { class: 'input', id: 'bf-mobile', type: 'tel', inputmode: 'numeric', maxlength: 10, value: existing?.mobile || '' })
  ]));

  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:8px',
    onclick: () => save()
  }, isEdit ? 'Save changes' : 'Add delivery boy'));

  if (isEdit) {
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:10px',
      onclick: async () => {
        if (!await confirmDialog('Reset password?',
          'Clear ' + existing.name + '\'s password? They\'ll set a new one on next login.', 'Reset')) return;
        existing.password_hash = null;
        Store.save();
        toast('Password reset');
      }
    }, existing.password_hash ? '🔑 Reset password' : '🔑 No password set'));

    wrap.appendChild(el('button', {
      class: 'btn btn-danger btn-block', style: 'margin-top:8px',
      onclick: async () => {
        if (!await confirmDialog('Remove delivery boy?',
          existing.name + ' will be removed. Customers assigned to them will need re-assignment.', 'Remove')) return;
        const bid = existing.id;
        // Unassign customers
        Store.data.users.filter(u => u.assignedBoyId === bid).forEach(u => u.assignedBoyId = null);
        const notifIds = Store.data.notifications.filter(n => n.userId === bid).map(n => n.id);
        Store.data.users = Store.data.users.filter(u => u.id !== bid);
        Store.data.notifications = Store.data.notifications.filter(n => n.userId !== bid);
        Store.save();
        await Promise.all([
          Store.removeRemote('users', bid),
          Store.removeRemote('notifications', notifIds)
        ]);
        toast('Delivery boy removed');
        closeModal();
        ownerSettings();
      }
    }, 'Remove delivery boy'));
  }

  function save() {
    const name = document.getElementById('bf-name').value.trim();
    const mobile = document.getElementById('bf-mobile').value.replace(/\D/g, '');
    if (!name) return toast('Enter name', 'error');
    if (mobile.length !== 10) return toast('Enter 10-digit mobile', 'error');
    const conflict = Store.data.users.find(u => u.mobile === mobile && u.id !== existing?.id);
    if (conflict) return toast('That mobile is already used by another account', 'error');
    if (existing) {
      Object.assign(existing, { name, mobile, photo: photoData || null });
    } else {
      const ownerId = App.user && App.user.role === 'owner' ? App.user.id : null;
      Store.data.users.push({
        id: uid(), name, mobile, role: 'delivery_boy',
        photo: photoData || null, ownerId
      });
    }
    Store.save();
    toast(existing ? 'Saved' : 'Delivery boy added', 'success');
    closeModal();
    ownerSettings();
  }

  openModal(isEdit ? 'Edit delivery boy' : 'Add delivery boy', wrap);
}

function customerDetail(id) {
  const c = getCustomer(id);
  if (!c) return;
  const month = monthKey();
  const bill = customerMonthBill(id, month);
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'card', style: 'margin-bottom:14px' }, [
    el('div', { class: 'card-row', style: 'gap:12px' }, [
      avatarFor(c, 56),
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-weight:700;font-size:16px' }, c.name),
        el('div', { class: 'text-muted', style: 'font-size:13px' }, '+91 ' + c.mobile),
        presenceBadge(c.id)
      ]),
      el('span', { class: 'badge info' }, c.plan)
    ]),
    c.address ? el('div', { class: 'text-muted', style: 'font-size:13px;margin-top:6px' }, c.address) : null
  ]));
  wrap.appendChild(el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Month deliveries'),
      el('div', { class: 'stat-value' }, String(bill.deliveries))
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, 'Month bill'),
      el('div', { class: 'stat-value' }, fmtMoney(bill.total))
    ])
  ]));
  // Jar / bottle tracking — gated until the jars_held/jar_deposit migration is run
  if (JARS_ENABLED) wrap.appendChild(el('div', { class: 'card', style: 'margin-bottom:14px' }, [
    el('div', { class: 'card-row' }, [
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-weight:700;font-size:15px' }, '🫙 Jars out: ' + (c.jars_held || 0)),
        el('div', { class: 'text-muted', style: 'font-size:13px' }, 'Deposit held: ' + fmtMoney(c.jar_deposit || 0))
      ]),
      el('div', { class: 'row gap-sm' }, [
        el('button', { class: 'btn btn-sm btn-ghost', 'aria-label': 'Empty returned',
          onclick: () => { c.jars_held = Math.max(0, (c.jars_held || 0) - 1); Store.save(); customerDetail(id); } }, '− returned'),
        el('button', { class: 'btn btn-sm btn-primary', 'aria-label': 'Jar given',
          onclick: () => { c.jars_held = (c.jars_held || 0) + 1; Store.save(); customerDetail(id); } }, '+ gave')
      ])
    ])
  ]));
  wrap.appendChild(el('button', {
    class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
    onclick: () => customerForm(c)
  }, 'Edit details'));
  wrap.appendChild(el('a', {
    class: 'btn btn-primary btn-block', style: 'margin-top:8px',
    href: 'https://wa.me/91' + c.mobile, target: '_blank', rel: 'noopener'
  }, 'WhatsApp'));
  openModal(c.name, wrap);
}

/* ── Owner: today (mark deliveries) ───────────────────────── */
function ownerToday() {
  todayView({ role: 'owner', rerender: ownerToday });
}

/* Shared today/route view used by Owner and Delivery Boy */
function todayView({ role, rerender }) {
  clear($view);
  const today = todayISO();
  const isOwner = role === 'owner';
  let customers = getCustomers();
  if (role === 'delivery_boy') {
    customers = customers.filter(c => c.assignedBoyId === App.user.id);
  }
  // Frequency filter: only show customers whose delivery is due today (daily customers always pass)
  customers = customers.filter(c => isDeliveryDue(c, today));

  // Compute status for each customer
  const withStatus = customers.map(c => {
    const paused = isPaused(c.id, today);
    const row = getDelivery(c.id, today);
    const status = paused ? 'paused' : (row?.status || 'pending');
    return { c, status, row };
  });
  const total = withStatus.filter(x => x.status !== 'paused').length;
  const delivered = withStatus.filter(x => x.status === 'delivered');
  const skipped = withStatus.filter(x => x.status === 'skipped');
  const pending = withStatus.filter(x => x.status === 'pending');

  // App.todayFilter: 'pending' (default) | 'delivered' | 'skipped' | 'all'
  const filter = App.todayFilter || 'pending';

  $view.appendChild(topbar({
    title: t('today'),
    subtitle: prettyDate(today) + ' · ' + (delivered.length + skipped.length) + '/' + total + ' done',
    bell: true,
    right: el('button', {
      class: 'icon-btn', 'aria-label': t('print_route'),
      onclick: () => printRouteSheet(role === 'delivery_boy' ? App.user.id : null),
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>'
    })
  }));
  const page = el('div', { class: 'page' });

  if (customers.length === 0) {
    page.appendChild(emptyState('👥', 'No customers', isOwner ? 'Add customers to start marking deliveries.' : 'No customers assigned to you yet.'));
    $view.appendChild(page);
    return;
  }

  const doneCount = delivered.length + skipped.length;

  // Holiday banner if today is a holiday
  const todayHoliday = getHoliday(today);
  if (todayHoliday) {
    page.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px;background:#FEF3C7;border-color:#FCD34D' }, [
      el('div', { style: 'font-weight:700;font-size:16px' }, '🗓️ ' + todayHoliday.label),
      el('div', { class: 'text-muted', style: 'font-size:13px;margin-top:4px' }, 'Today is a holiday. Most dairies don\'t deliver — but you can still mark deliveries below if you do.')
    ]));
  }

  // Progress summary card
  page.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
    el('div', { class: 'row gap-md', style: 'align-items:center' }, [
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-weight:700;font-size:16px' }, pending.length + ' pending'),
        el('div', { class: 'text-muted', style: 'font-size:13px' }, delivered.length + ' delivered · ' + skipped.length + ' skipped' + (total > 0 && pending.length === 0 ? ' · all done 🎉' : ''))
      ]),
      total > 0 ? el('div', { style: 'font-family:var(--font-head);font-weight:800;font-size:22px;color:var(--primary)' }, doneCount + '/' + total) : null
    ]),
    el('div', { class: 'progress-track', style: 'margin-top:10px' }, [
      el('div', { class: 'progress-fill', style: 'width:' + (total ? Math.round((doneCount / total) * 100) : 0) + '%' })
    ])
  ]));

  // Filter chips
  const mkChip = (key, label, count) => el('button', {
    class: 'chip' + (filter === key ? ' active' : ''),
    onclick: () => { App.todayFilter = key; rerender(); }
  }, label + ' (' + count + ')');
  page.appendChild(el('div', { class: 'chip-row' }, [
    mkChip('pending', 'Pending', pending.length),
    mkChip('delivered', 'Delivered', delivered.length),
    mkChip('skipped', 'Skipped', skipped.length),
    mkChip('all', 'All', customers.length)
  ]));

  // Filter rows based on chip
  const visible = filter === 'all' ? withStatus
    : filter === 'delivered' ? delivered
    : filter === 'skipped' ? skipped
    : pending;

  // Bulk action: mark all pending as delivered (only when on Pending filter with items)
  if (filter === 'pending' && pending.length > 0 && isOwner) {
    page.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:10px',
      onclick: async () => {
        if (!await confirmDialog('Mark all as delivered?', pending.length + ' pending customer' + (pending.length === 1 ? '' : 's') + ' will be marked Delivered for today.', 'Mark all delivered')) return;
        pending.forEach(({ c }) => {
          setDelivery(c.id, today, 'delivered');
          notify(c.id, 'delivery', 'Delivery done', fmtQty(c.dailyMl) + ' delivered today.');
        });
        toast(pending.length + ' marked delivered', 'success');
        rerender();
      }
    }, '✓ Mark all ' + pending.length + ' as delivered'));
  }

  if (visible.length === 0) {
    const emptyMsg = {
      pending:   ['✅', 'All done!', 'No pending deliveries today.'],
      delivered: ['💧', 'Nothing delivered yet', 'Mark your first delivery to see it here.'],
      skipped:   ['—', 'Nothing skipped', 'No skipped deliveries today.'],
      all:       ['👥', 'No customers', 'Add customers to start.']
    }[filter];
    page.appendChild(emptyState(emptyMsg[0], emptyMsg[1], emptyMsg[2]));
    $view.appendChild(page);
    return;
  }

  const list = el('div', { class: 'list' });
  visible.forEach(({ c, status: _s, row: _r }) => {
    const paused = isPaused(c.id, today);
    const row = getDelivery(c.id, today);
    const status = paused ? 'paused' : (row?.status || 'pending');
    const photo = row?.photo;

    const markDone = async (withPhoto) => {
      let pic = photo;
      if (withPhoto) {
        pic = await capturePhoto();
        if (!pic) return; // user cancelled
      }
      setDelivery(c.id, today, 'delivered', pic);
      notify(c.id, 'delivery', 'Delivery done', fmtQty(c.dailyMl) + ' delivered today.');
      rerender();
    };
    const markSkip = () => {
      setDelivery(c.id, today, 'skipped');
      notify(c.id, 'delivery', 'Delivery skipped', 'Today\'s delivery was skipped.');
      rerender();
    };

    const actions = paused
      ? el('span', { class: 'badge muted' }, t('paused'))
      : el('div', { class: 'row gap-sm' }, [
          photo ? el('img', { class: 'photo-thumb', src: photo, onclick: () => viewPhoto(photo) }) : null,
          el('button', { class: 'btn-camera', 'aria-label': t('add_photo'),
            onclick: () => markDone(true),
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
          }),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: markSkip
          }, t('skip')),
          el('button', {
            class: 'btn btn-sm ' + (status === 'delivered' ? 'btn-primary' : 'btn-ghost'),
            onclick: () => markDone(false)
          }, t('done'))
        ]);

    list.appendChild(el('div', { class: 'list-item' }, [
      avatarFor(c),
      el('div', { class: 'li-body' }, [
        el('div', { class: 'li-title' }, c.name),
        el('div', { class: 'li-sub' },
          fmtQty(c.dailyMl) + ' · ' +
          (paused ? t('paused')
           : status === 'delivered' ? t('delivered')
           : status === 'skipped' ? t('skipped')
           : t('pending')) +
          (c.address ? ' · ' + c.address.slice(0, 24) + (c.address.length > 24 ? '…' : '') : '')
        )
      ]),
      actions
    ]));
  });
  page.appendChild(list);
  $view.appendChild(page);
}

function viewPhoto(dataUrl) {
  openModal(t('view_photo'), el('div', { class: 'photo-viewer' }, [
    el('img', { src: dataUrl, alt: 'Delivery photo' })
  ]));
}

function printRouteSheet(boyId) {
  // Build a hidden print-only block, then window.print()
  const today = todayISO();
  let customers = getCustomers().filter(c => !isPaused(c.id, today));
  if (boyId) customers = customers.filter(c => c.assignedBoyId === boyId);

  const old = document.getElementById('printRoute');
  if (old) old.remove();

  const block = el('section', { class: 'print-route', id: 'printRoute' }, [
    el('h1', {}, 'Delivery Route — ' + prettyDate(today)),
    el('div', { style: 'font-size:12px;margin-bottom:12px' }, customers.length + ' stops · ' + fmtQty(customers.reduce((s, c) => s + c.dailyMl, 0))),
    ...customers.map((c, i) => el('div', { class: 'stop' }, [
      el('div', { style: 'font-weight:700;font-size:14px' }, (i+1) + '. ' + c.name + ' — ' + fmtQty(c.dailyMl)),
      el('div', { style: 'font-size:12px;color:#444' }, c.address || '—'),
      el('div', { style: 'font-size:12px;color:#444' }, '+91 ' + c.mobile),
      el('div', { style: 'margin-top:6px;font-size:11px' }, '☐ Delivered    ☐ Skipped    Signed: ____________')
    ]))
  ]);
  document.body.appendChild(block);
  window.print();
  // Remove after a beat (some browsers print synchronously)
  setTimeout(() => block.remove(), 500);
}

/* ── Owner: bills ─────────────────────────────────────────── */
function ownerBills() {
  $view.appendChild(topbar({ title: 'Bills', subtitle: prettyMonth(monthKey()), bell: true }));
  const page = el('div', { class: 'page' });
  const month = monthKey();
  const customers = getCustomers();
  if (customers.length === 0) {
    page.appendChild(emptyState('📄', 'No bills', 'Bills appear once you have customers and deliveries.'));
    $view.appendChild(page); return;
  }
  const list = el('div', { class: 'list' });
  customers.forEach(c => {
    const b = customerMonthBill(c.id, month);
    const badgeCls = b.due === 0 && b.total > 0 ? 'success' : b.due > 0 ? 'warn' : 'muted';
    const badgeText = b.total === 0 ? 'No deliveries' : b.due === 0 ? 'Paid' : 'Due ' + fmtMoney(b.due);
    const item = el('button', {
      class: 'list-item', style: 'text-align:left;background:var(--surface);width:100%',
      onclick: () => billDetail(c.id, month)
    }, [
      avatarFor(c),
      el('div', { class: 'li-body' }, [
        el('div', { class: 'li-title' }, c.name),
        el('div', { class: 'li-sub' }, b.deliveries + ' deliveries · ' + fmtMoney(b.total))
      ]),
      el('span', { class: 'badge ' + badgeCls }, badgeText)
    ]);
    list.appendChild(item);
  });
  page.appendChild(list);
  $view.appendChild(page);
}

function billDetail(customerId, month) {
  const c = getCustomer(customerId);
  const b = customerMonthBill(customerId, month);
  const products = Store.data.settings.products;
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'text-muted', style: 'margin-bottom:10px' }, prettyMonth(month)));
  wrap.appendChild(el('div', { class: 'bill-rows' }, [
    el('div', { class: 'bill-row' }, [
      el('span', {}, 'Water delivered'),
      el('span', { class: 'text-mono' }, fmtQty(b.totalMl) + ' · ' + b.deliveries + ' days')
    ]),
    el('div', { class: 'bill-row' }, [
      el('span', {}, 'Water amount @ ' + fmtMoney(Store.data.settings.pricePerLitre) + '/L'),
      el('span', { class: 'text-mono' }, fmtMoney(b.milkAmt))
    ]),
    ...b.extras.map(o => el('div', { class: 'bill-row' }, [
      el('span', {}, products[o.productKey].name + ' × ' + o.qty),
      el('span', { class: 'text-mono' }, fmtMoney(products[o.productKey].price * o.qty))
    ])),
    b.paid > 0 ? el('div', { class: 'bill-row' }, [
      el('span', {}, 'Paid'),
      el('span', { class: 'text-mono', style: 'color:var(--success)' }, '− ' + fmtMoney(b.paid))
    ]) : null,
    el('div', { class: 'bill-row total' }, [
      el('span', {}, b.due > 0 ? 'Amount due' : 'Total'),
      el('span', { class: 'text-mono' }, fmtMoney(b.due > 0 ? b.due : b.total))
    ])
  ]));
  if (App.user.role === 'owner' && c && b.total > 0) {
    // Send via WhatsApp (any state)
    wrap.appendChild(el('a', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:14px',
      href: waLink(c.mobile, billWhatsAppMessage(c, b, prettyMonth(month))),
      target: '_blank', rel: 'noopener'
    }, '💬 ' + t('send_whatsapp')));

    if (b.due > 0) {
      // Show QR for customer to scan
      wrap.appendChild(el('button', {
        class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
        onclick: () => showPayQR(b.due, c.name + ' — ' + prettyMonth(month))
      }, '📱 ' + t('show_qr')));

      // Mark as paid (cash collected)
      wrap.appendChild(el('button', {
        class: 'btn btn-primary btn-block', style: 'margin-top:8px',
        onclick: () => {
          Store.data.payments.push({ id: uid(), customerId, month, amount: b.due, date: new Date().toISOString(), method: 'cash' });
          Store.save();
          notify(customerId, 'payment', 'Payment received', fmtMoney(b.due) + ' marked paid for ' + prettyMonth(month));
          toast('Marked as paid', 'success');
          closeModal();
          viewOwner();
        }
      }, 'Mark as paid (cash)'));
    }
  }
  openModal(c ? c.name + ' — Bill' : 'Bill', wrap);
}

function showPayQR(amount, note) {
  const link = upiDeepLink(amount, note);
  const img = makeQRImage(link);
  const wrap = el('div', {});
  wrap.appendChild(el('p', { class: 'text-muted text-center' },
    'Customer scans this with any UPI app (Google Pay, PhonePe, Paytm).'));
  const box = el('div', { class: 'qr-box' });
  if (img) box.appendChild(img);
  else box.appendChild(el('div', { class: 'text-muted' }, 'QR generator not loaded'));
  box.appendChild(el('div', { class: 'qr-amount' }, fmtMoney(amount)));
  box.appendChild(el('div', { class: 'qr-id' }, Store.data.settings.upiId));
  wrap.appendChild(box);
  openModal('Scan to pay', wrap);
}

/* ── Owner: reports ───────────────────────────────────────── */
function getReportFilter() {
  if (!App.reportFilter) {
    App.reportFilter = { period: 'month', from: null, to: null, customerId: null, productKey: null };
  }
  return App.reportFilter;
}
function reportRange(f) {
  const today = todayISO();
  if (f.period === 'today') return { from: today, to: today };
  if (f.period === 'week') {
    const d = new Date(); d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  if (f.period === 'month') {
    return { from: monthKey() + '-01', to: today };
  }
  return { from: f.from || today, to: f.to || today };
}
function reportRangeLabel(f) {
  const { from, to } = reportRange(f);
  if (f.period === 'today') return 'Today (' + prettyDate(from) + ')';
  if (f.period === 'week') return 'Last 7 days';
  if (f.period === 'month') return prettyMonth(monthKey());
  return prettyDate(from) + ' → ' + prettyDate(to);
}
function withinRange(iso, from, to) {
  return iso >= from && iso <= to;
}

function ownerReports() {
  clear($view);
  $view.appendChild(topbar({ title: 'Reports', subtitle: 'Daily & monthly', bell: true }));
  const page = el('div', { class: 'page' });
  const f = getReportFilter();
  const { from, to } = reportRange(f);

  // Filter bar
  page.appendChild(buildFilterBar(f, () => ownerReports()));

  // Compute scoped data
  const customers = getCustomers();
  const customerScope = f.customerId ? customers.filter(c => c.id === f.customerId) : customers;
  const customerIds = new Set(customerScope.map(c => c.id));

  const rangeDeliveries = Store.data.deliveries.filter(d =>
    customerIds.has(d.customerId) && d.status === 'delivered' && withinRange(d.date, from, to)
  );
  const rangeMl = rangeDeliveries.reduce((s, d) => s + d.ml, 0);

  const rangePayments = Store.data.payments.filter(p =>
    customerIds.has(p.customerId) && withinRange(p.date.slice(0, 10), from, to)
  );
  const rangeCollected = rangePayments.reduce((s, p) => s + p.amount, 0);

  const rangeExtras = Store.data.extraOrders.filter(o =>
    customerIds.has(o.customerId) && o.status !== 'cancelled' &&
    withinRange(o.date.slice(0, 10), from, to) &&
    (!f.productKey || o.productKey === f.productKey)
  );
  const products = Store.data.settings.products;
  const rangeExtrasAmt = rangeExtras.reduce((s, o) => s + (products[o.productKey]?.price || 0) * o.qty, 0);

  // Outstanding always uses current month (most common ask)
  const outMonth = monthKey();
  const outBills = customerScope.map(c => ({ c, b: customerMonthBill(c.id, outMonth) }));
  const outDue = outBills.reduce((s, x) => s + x.b.due, 0);
  const outCount = outBills.filter(x => x.b.due > 0).length;

  // Hero
  const rangeRev = customerScope.reduce((s, c) => {
    const b = customerMonthBill(c.id, outMonth);
    return s + b.total;
  }, 0);
  page.appendChild(el('div', { class: 'hero-stat' }, [
    el('div', { class: 'hero-stat-label' }, reportRangeLabel(f) + ' · ' + customerScope.length + ' customer' + (customerScope.length === 1 ? '' : 's')),
    el('div', { class: 'hero-stat-value' }, fmtMoney(rangeRev)),
    el('div', { class: 'hero-stat-foot' }, fmtQty(rangeMl) + ' delivered · ' + rangeDeliveries.length + ' deliveries in range')
  ]));

  // 5 clickable stat cards
  const mkStat = (kind, label, value, valueStyle) => el('button', {
    class: 'stat is-clickable', type: 'button', onclick: () => ownerReportDetail(kind)
  }, [
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value', style: valueStyle || '' }, value)
  ]);
  page.appendChild(el('div', { class: 'stat-grid' }, [
    mkStat('volume', 'Volume sold', fmtQty(rangeMl)),
    mkStat('deliveries', 'Deliveries', String(rangeDeliveries.length)),
    mkStat('collected', 'Collected', fmtMoney(rangeCollected), 'color:var(--success)'),
    mkStat('outstanding', 'Outstanding', fmtMoney(outDue), outDue > 0 ? 'color:var(--warning)' : ''),
    mkStat('extras', 'Extras', fmtMoney(rangeExtrasAmt))
  ]));

  if (outCount > 0) {
    page.appendChild(el('div', { class: 'card', style: 'margin-top:14px;cursor:pointer', onclick: () => ownerReportDetail('outstanding') }, [
      el('div', { class: 'row gap-md', style: 'align-items:center' }, [
        el('div', { class: 'li-avatar', style: 'background:var(--warning);color:#fff' }, '⚠'),
        el('div', { style: 'flex:1' }, [
          el('div', { style: 'font-weight:700' }, outCount + ' customer' + (outCount === 1 ? '' : 's') + ' with dues'),
          el('div', { class: 'text-muted', style: 'font-size:13px' }, 'Tap to send WhatsApp reminders')
        ]),
        el('span', { class: 'link-btn' }, 'Open →')
      ])
    ]));
  }

  // Per-customer breakdown (current month)
  page.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [
    el('h2', {}, 'Per customer (' + prettyMonth(outMonth) + ')')
  ]));
  const list = el('div', { class: 'list' });
  customerScope.forEach(c => {
    const b = customerMonthBill(c.id, outMonth);
    list.appendChild(el('div', { class: 'list-item is-clickable', onclick: () => ownerCustomerMonth(c.id, outMonth) }, [
      avatarFor(c),
      el('div', { class: 'li-body' }, [
        el('div', { class: 'li-title' }, c.name),
        el('div', { class: 'li-sub' }, fmtQty(b.totalMl) + ' · ' + b.deliveries + ' deliveries')
      ]),
      el('div', { class: 'li-aside' }, [
        el('div', { class: 'amount' }, fmtMoney(b.total)),
        el('div', { style: 'font-size:11px', class: b.due > 0 ? '' : 'text-muted' }, b.due > 0 ? fmtMoney(b.due) + ' due' : 'Settled')
      ])
    ]));
  });
  page.appendChild(list);

  $view.appendChild(page);
}

function buildFilterBar(f, onChange) {
  const bar = el('div', { class: 'filter-bar' });

  // Period chips
  const periodRow = el('div', { class: 'chip-row' });
  [['today','Today'], ['week','Week'], ['month','Month'], ['custom','Custom']].forEach(([k, label]) => {
    periodRow.appendChild(el('button', {
      class: 'chip' + (f.period === k ? ' active' : ''),
      onclick: () => { f.period = k; if (k === 'custom' && !f.from) { const m = monthKey() + '-01'; f.from = m; f.to = todayISO(); } onChange(); }
    }, label));
  });
  bar.appendChild(periodRow);

  // Custom date inputs (only when period === 'custom')
  if (f.period === 'custom') {
    bar.appendChild(el('div', { class: 'row gap-sm', style: 'margin-top:8px' }, [
      el('input', { class: 'input', type: 'date', value: f.from || '', onchange: (e) => { f.from = e.target.value; onChange(); } }),
      el('span', { style: 'align-self:center;color:var(--text-muted)' }, '→'),
      el('input', { class: 'input', type: 'date', value: f.to || '', onchange: (e) => { f.to = e.target.value; onChange(); } })
    ]));
  }

  // Customer + Product dropdowns
  const customers = getCustomers();
  const products = Store.data.settings.products;
  const dropRow = el('div', { class: 'row gap-sm', style: 'margin-top:8px' });

  const custSel = el('select', { class: 'select', onchange: (e) => { f.customerId = e.target.value || null; onChange(); } }, [
    el('option', { value: '' }, 'All customers'),
    ...customers.map(c => el('option', { value: c.id, selected: f.customerId === c.id }, c.name))
  ]);
  dropRow.appendChild(custSel);

  const prodSel = el('select', { class: 'select', onchange: (e) => { f.productKey = e.target.value || null; onChange(); } }, [
    el('option', { value: '' }, 'All products'),
    ...Object.entries(products).filter(([, p]) => p.active !== false).map(([key, p]) =>
      el('option', { value: key, selected: f.productKey === key }, p.name)
    )
  ]);
  dropRow.appendChild(prodSel);
  bar.appendChild(dropRow);

  // Reset
  const isFiltered = f.period !== 'month' || f.customerId || f.productKey;
  if (isFiltered) {
    bar.appendChild(el('button', {
      class: 'link-btn', style: 'margin-top:8px;display:block',
      onclick: () => { f.period = 'month'; f.from = null; f.to = null; f.customerId = null; f.productKey = null; onChange(); }
    }, 'Reset filters'));
  }

  return bar;
}

function ownerReportDetail(kind) {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  const back = () => { document.body.classList.remove('no-tabs'); $tabbar.hidden = false; viewOwner(); };

  const f = getReportFilter();
  const { from, to } = reportRange(f);
  const customers = getCustomers();
  const customerScope = f.customerId ? customers.filter(c => c.id === f.customerId) : customers;
  const customerIds = new Set(customerScope.map(c => c.id));
  const cName = (id) => customers.find(c => c.id === id)?.name || 'Unknown';
  const products = Store.data.settings.products;

  const titles = {
    volume:      'Volume sold',
    deliveries:  'Deliveries',
    collected:   'Collected',
    outstanding: 'Outstanding',
    extras:      'Extras'
  };
  const sub = (kind === 'outstanding' ? prettyMonth(monthKey()) : reportRangeLabel(f))
            + (f.customerId ? ' · ' + cName(f.customerId) : '')
            + (f.productKey && kind === 'extras' ? ' · ' + (products[f.productKey]?.name || 'Product') : '');

  $view.appendChild(topbar({
    title: titles[kind] || 'Report', subtitle: sub, back,
    right: el('button', { class: 'icon-btn', onclick: () => window.print(), 'aria-label': 'Print',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>' })
  }));

  const page = el('div', { class: 'page printable' });
  page.appendChild(el('div', { class: 'print-only print-header' }, [
    el('h1', {}, 'DailyWater — ' + (titles[kind] || 'Report')),
    el('div', { class: 'text-muted' }, sub + ' · Printed ' + new Date().toLocaleString('en-IN'))
  ]));

  // Filter bar (live, non-print)
  page.appendChild(el('div', { class: 'no-print' }, [buildFilterBar(f, () => ownerReportDetail(kind))]));

  if (kind === 'volume') {
    const days = {};
    Store.data.deliveries
      .filter(d => customerIds.has(d.customerId) && d.status === 'delivered' && withinRange(d.date, from, to))
      .forEach(d => { days[d.date] = (days[d.date] || 0) + d.ml; });
    const sorted = Object.entries(days).sort(([a], [b]) => a.localeCompare(b));
    const totalMl = sorted.reduce((s, [, ml]) => s + ml, 0);
    page.appendChild(summaryRow([
      ['Days', String(sorted.length)],
      ['Volume', fmtQty(totalMl)],
      ['Avg/day', sorted.length ? fmtQty(Math.round(totalMl / sorted.length)) : '0ml']
    ]));
    if (sorted.length === 0) {
      page.appendChild(emptyState('💧', 'No deliveries in range', 'Try a wider period or different customer.'));
    } else {
      page.appendChild(reportTable(['Date', 'Volume', 'Revenue @ ' + fmtMoney(Store.data.settings.pricePerLitre) + '/L'],
        sorted.map(([date, ml]) => [prettyDate(date), fmtQty(ml), fmtMoney((ml/1000) * Store.data.settings.pricePerLitre)])));
    }
  }

  else if (kind === 'deliveries') {
    const rows = Store.data.deliveries
      .filter(d => customerIds.has(d.customerId) && withinRange(d.date, from, to))
      .sort((a, b) => b.date.localeCompare(a.date));
    const delivered = rows.filter(d => d.status === 'delivered');
    page.appendChild(summaryRow([
      ['Total entries', String(rows.length)],
      ['Delivered', String(delivered.length)],
      ['Skipped', String(rows.length - delivered.length)]
    ]));
    if (rows.length === 0) {
      page.appendChild(emptyState('🚚', 'No deliveries', 'No data in this range.'));
    } else {
      page.appendChild(reportTable(['Date', 'Customer', 'Status', 'Qty'],
        rows.map(d => ({
          cells: [prettyDate(d.date), cName(d.customerId), d.status === 'delivered' ? 'Delivered' : 'Skipped', d.status === 'delivered' ? fmtQty(d.ml) : '—'],
          onclick: () => ownerCustomerMonth(d.customerId, d.date.slice(0, 7))
        }))));
    }
  }

  else if (kind === 'collected') {
    const rows = Store.data.payments
      .filter(p => customerIds.has(p.customerId) && withinRange(p.date.slice(0, 10), from, to))
      .sort((a, b) => b.date.localeCompare(a.date));
    const total = rows.reduce((s, p) => s + p.amount, 0);
    const byMethod = rows.reduce((m, p) => { m[p.method] = (m[p.method] || 0) + p.amount; return m; }, {});
    page.appendChild(summaryRow([
      ['Payments', String(rows.length)],
      ['Total', fmtMoney(total)],
      ['UPI', fmtMoney(byMethod.upi || 0)],
      ['Cash', fmtMoney(byMethod.cash || 0)]
    ]));
    if (rows.length === 0) {
      page.appendChild(emptyState('💳', 'No payments', 'No payments received in this range.'));
    } else {
      page.appendChild(reportTable(['Date', 'Customer', 'Month', 'Method', 'Amount'],
        rows.map(p => ({
          cells: [prettyDate(p.date.slice(0, 10)), cName(p.customerId), prettyMonth(p.month), p.method.toUpperCase(), fmtMoney(p.amount)],
          onclick: () => ownerCustomerMonth(p.customerId, p.month)
        }))));
    }
  }

  else if (kind === 'outstanding') {
    const month = monthKey();
    const dues = customerScope.map(c => ({ c, b: customerMonthBill(c.id, month) }))
      .filter(x => x.b.due > 0).sort((a, b) => b.b.due - a.b.due);
    const totalDue = dues.reduce((s, x) => s + x.b.due, 0);
    page.appendChild(summaryRow([
      ['Customers', String(dues.length)],
      ['Total due', fmtMoney(totalDue)]
    ]));
    if (dues.length === 0) {
      page.appendChild(emptyState('✓', 'All settled', 'No pending dues for ' + prettyMonth(month) + '.'));
    } else {
      const list = el('div', { class: 'list' });
      dues.forEach(({ c, b }) => {
        list.appendChild(el('div', { class: 'list-item' }, [
          el('div', { onclick: () => ownerCustomerMonth(c.id, month), style: 'cursor:pointer' }, [avatarFor(c)]),
          el('div', { class: 'li-body', onclick: () => ownerCustomerMonth(c.id, month), style: 'cursor:pointer' }, [
            el('div', { class: 'li-title' }, c.name),
            el('div', { class: 'li-sub' }, fmtMoney(b.total) + ' bill · ' + b.deliveries + ' days')
          ]),
          el('div', { class: 'li-aside' }, [
            el('div', { class: 'amount', style: 'color:var(--warning)' }, fmtMoney(b.due) + ' due'),
            el('button', {
              class: 'btn btn-sm btn-primary no-print', style: 'margin-top:4px',
              onclick: () => previewBillPDF(c, b, month)
            }, '📄 Send')
          ])
        ]));
      });
      page.appendChild(list);
      // Print version
      page.appendChild(el('div', { class: 'print-only' }, [
        reportTable(['#', 'Customer', 'Mobile', 'Bill', 'Paid', 'Due'],
          dues.map(({ c, b }, i) => [String(i + 1), c.name, c.mobile, fmtMoney(b.total), fmtMoney(b.paid), fmtMoney(b.due)]))
      ]));
    }
  }

  else if (kind === 'extras') {
    const rows = Store.data.extraOrders
      .filter(o => customerIds.has(o.customerId) && o.status !== 'cancelled' &&
        withinRange(o.date.slice(0, 10), from, to) &&
        (!f.productKey || o.productKey === f.productKey))
      .sort((a, b) => b.date.localeCompare(a.date));

    // Group by product for summary
    const byProduct = {};
    rows.forEach(o => {
      const k = o.productKey;
      const p = products[k];
      if (!byProduct[k]) byProduct[k] = { product: p, qty: 0, amount: 0 };
      byProduct[k].qty += o.qty;
      byProduct[k].amount += (p?.price || 0) * o.qty;
    });
    const productSummary = Object.entries(byProduct).sort(([, a], [, b]) => b.amount - a.amount);
    const totalQty = rows.reduce((s, o) => s + o.qty, 0);
    const totalAmt = rows.reduce((s, o) => s + (products[o.productKey]?.price || 0) * o.qty, 0);

    page.appendChild(summaryRow([
      ['Orders', String(rows.length)],
      ['Items', String(totalQty)],
      ['Revenue', fmtMoney(totalAmt)]
    ]));

    if (rows.length === 0) {
      page.appendChild(emptyState('🛒', 'No extras orders', 'No orders in this range.'));
    } else {
      // Per-product summary — only show when ≥2 distinct products in result
      if (productSummary.length >= 2) {
        page.appendChild(el('div', { class: 'section-head', style: 'margin-top:12px' }, [el('h2', {}, 'By product')]));
        page.appendChild(reportTable(['Product', 'Qty', 'Revenue'],
          productSummary.map(([, x]) => [(x.product?.emoji || '') + ' ' + (x.product?.name || 'Removed'), String(x.qty), fmtMoney(x.amount)])));
      }

      // Order list
      page.appendChild(el('div', { class: 'section-head', style: 'margin-top:12px' }, [el('h2', {}, 'Orders')]));
      page.appendChild(reportTable(['Date', 'Customer', 'Product', 'Qty', 'Amount', 'Status'],
        rows.map(o => {
          const p = products[o.productKey];
          return {
            cells: [prettyDate(o.date.slice(0, 10)), cName(o.customerId), p?.name || 'Removed', String(o.qty), fmtMoney((p?.price || 0) * o.qty), o.status],
            onclick: () => ownerCustomerMonth(o.customerId, o.date.slice(0, 7))
          };
        })));
    }
  }

  $view.appendChild(page);
}

/* ─── Owner: settings (products + general) ─────────────────── */
function slugify(s) {
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'item';
}

function uniqueProductKey(base) {
  const prods = Store.data.settings.products;
  if (!prods[base]) return base;
  let i = 2;
  while (prods[base + '_' + i]) i++;
  return base + '_' + i;
}

// Module-level section state — preserved across internal re-renders (after add/delete etc.)
let _ownerSettingsSection = 'list';
// Distinguishes "we're entering settings from the owner home" (push handler that returns to home)
// from internal re-renders within settings (don't push another handler).
let _ownerSettingsEntered = false;

// Entry point — call this from icon clicks etc. Always pushes a back handler returning to home.
function openOwnerSettings() {
  if (!_ownerSettingsEntered) {
    pushBackHandler(() => {
      _ownerSettingsSection = 'list';
      _ownerSettingsEntered = false;
      document.body.classList.remove('no-tabs');
      $tabbar.hidden = false;
      viewOwner();
    });
    _ownerSettingsEntered = true;
  }
  _ownerSettingsSection = 'list';
  ownerSettings();
}

function ownerSettings(target) {
  if (target !== undefined) {
    // Entering a subpage from the list → register a back-handler so swipe-back returns to list
    if (target !== 'list' && _ownerSettingsSection === 'list') {
      pushBackHandler(() => {
        _ownerSettingsSection = 'list';
        if (App.user && App.user.role === 'owner') ownerSettings();
      });
    }
    _ownerSettingsSection = target;
  }
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);

  const goBackToOwner = () => {
    // Pop the entry-handler we pushed in openOwnerSettings, which restores the owner home.
    if (_ownerSettingsEntered) {
      popBack();
    } else {
      document.body.classList.remove('no-tabs');
      $tabbar.hidden = false;
      _ownerSettingsSection = 'list';
      viewOwner();
    }
  };

  const sections = [
    { key: 'profile',  icon: '👤', title: 'My Profile',         subtitle: 'Photo, name, mobile' },
    { key: 'business', icon: '🏪', title: 'Business Info',      subtitle: 'Used in bills & PDF' },
    { key: 'pricing',  icon: '💰', title: 'Pricing & Payments', subtitle: 'Per-litre, UPI, WhatsApp' },
    { key: 'boys',     icon: '🚴', title: 'Delivery Boys',      subtitle: 'Manage your delivery team' },
    { key: 'holidays', icon: '🗓', title: 'Holidays',           subtitle: "Days you don't deliver" },
    { key: 'products', icon: '💧', title: 'Products (Extras)',  subtitle: 'Cans, bottles, dispensers, etc.' },
    { key: 'invite',   icon: '🔗', title: 'Invite customers',   subtitle: 'Share a join link / QR code' },
    { key: 'theme',    icon: '🎨', title: 'Appearance',         subtitle: 'Light, dark, or auto' },
    { key: 'lang',     icon: '🌐', title: 'Language',           subtitle: 'English, Hindi, Marathi' }
  ];
  const sec = _ownerSettingsSection === 'list' ? null : sections.find(x => x.key === _ownerSettingsSection);

  $view.appendChild(topbar({
    title: sec ? sec.title : 'Settings',
    subtitle: sec ? sec.subtitle : null,
    back: sec ? () => popBack() : goBackToOwner
  }));

  const page = el('div', { class: 'page settings-screen' });

  // ── Settings list (root view) ──
  if (_ownerSettingsSection === 'list') {
    const list = el('div', { class: 'sett-list' });
    sections.forEach(secMeta => {
      list.appendChild(el('button', {
        type: 'button', class: 'sett-row',
        onclick: () => ownerSettings(secMeta.key)
      }, [
        el('span', { class: 'sett-row-icon' }, secMeta.icon),
        el('span', { class: 'sett-row-body' }, [
          el('span', { class: 'sett-row-title' }, secMeta.title),
          el('span', { class: 'sett-row-sub' }, secMeta.subtitle)
        ]),
        el('span', { class: 'sett-row-arrow' }, '›')
      ]));
    });
    page.appendChild(list);
    $view.appendChild(page);
    return;
  }

  const s = Store.data.settings;
  const me = App.user;

  // ─── Invite customers (QR / join link) ───────────────────
  if (_ownerSettingsSection === 'invite') {
    const joinUrl = location.origin + location.pathname + '?join=' + App.user.id;
    const biz = (s && s.businessName) || 'our water service';
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'text-muted', style: 'font-size:13px;margin-bottom:14px' },
        'Share this with customers — they fill in their details and are added to your list automatically.')
    ]);
    const qrImg = makeQRImage(joinUrl);
    if (qrImg) {
      qrImg.style.cssText = 'width:190px;height:190px;border-radius:12px;image-rendering:pixelated';
      card.appendChild(el('div', { style: 'display:flex;justify-content:center;margin-bottom:16px' }, [qrImg]));
    }
    card.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Join link'),
      el('input', { class: 'input', readonly: true, value: joinUrl, onclick: (e) => e.target.select() })
    ]));
    card.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:4px',
      onclick: () => { try { navigator.clipboard.writeText(joinUrl); } catch (e) {} toast('Link copied', 'success'); }
    }, '📋 Copy link'));
    card.appendChild(el('a', {
      class: 'btn btn-primary btn-block', style: 'margin-top:8px',
      href: 'https://wa.me/?text=' + encodeURIComponent('Join ' + biz + ' for water delivery — register here: ' + joinUrl),
      target: '_blank', rel: 'noopener'
    }, '💬 Share on WhatsApp'));
    page.appendChild(card);
    $view.appendChild(page);
    return;
  }

  // ─── Profile ─────────────────────────────────────────────
  if (_ownerSettingsSection === 'profile') {
    // Photo card
    const myCard = el('div', { class: 'card', style: 'display:flex;align-items:center;gap:14px' });
    const myAvatarWrap = el('div', {});
    const renderMyAvatar = () => {
      myAvatarWrap.innerHTML = '';
      if (me.photo) {
        myAvatarWrap.appendChild(el('div', {
          class: 'avatar-photo is-tappable',
          style: 'width:64px;height:64px;border-radius:50%;background-image:url(' + me.photo + ');background-size:cover;background-position:center;cursor:zoom-in',
          onclick: () => openPhotoLightbox(me.photo, me.name),
          role: 'button', 'aria-label': 'View my photo'
        }));
      } else {
        myAvatarWrap.appendChild(el('div', { style: 'width:64px;height:64px;border-radius:50%;background:var(--primary-soft);color:var(--primary);display:grid;place-items:center;font-family:var(--font-head);font-weight:800;font-size:26px' }, (me.name || '?')[0].toUpperCase()));
      }
    };
    renderMyAvatar();
    myCard.appendChild(myAvatarWrap);
    myCard.appendChild(el('div', { style: 'flex:1' }, [
      el('div', { class: 'text-muted', style: 'font-size:12px' }, me.role === 'owner' ? 'Owner' : me.role === 'delivery_boy' ? 'Delivery Boy' : 'Customer'),
      el('div', { style: 'font-size:13px;margin-top:2px' }, 'Tap the camera to ' + (me.photo ? 'change' : 'add') + ' a photo')
    ]));
    myCard.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: async () => {
        const pic = await capturePhoto();
        if (pic) {
          me.photo = pic;
          Store.save();
          renderMyAvatar();
          toast('Profile photo updated', 'success');
        }
      }
    }, me.photo ? '✏️' : '📷'));
    page.appendChild(myCard);
    if (me.photo) {
      page.appendChild(el('button', {
        class: 'link-btn', style: 'display:block;margin:6px 0 14px;color:var(--danger)',
        onclick: () => {
          me.photo = null;
          Store.save();
          renderMyAvatar();
          toast('Photo removed');
        }
      }, 'Remove profile photo'));
    }

    // Editable details card
    const details = el('div', { class: 'card', style: 'margin-top:12px' });
    details.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Full name'),
      el('input', { class: 'input', id: 'pf-name', type: 'text', value: me.name || '' })
    ]));
    details.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Mobile (10 digits)'),
      el('input', { class: 'input', id: 'pf-mobile', type: 'tel', inputmode: 'numeric', maxlength: 10, value: me.mobile || '' })
    ]));
    details.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Address'),
      el('textarea', { class: 'input', id: 'pf-addr', rows: 2, placeholder: 'Your address (optional)' }, me.address || '')
    ]));
    details.appendChild(el('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => {
        const name = document.getElementById('pf-name').value.trim();
        const mobile = document.getElementById('pf-mobile').value.replace(/\D/g, '');
        const addr = document.getElementById('pf-addr').value.trim();
        if (!name) return toast('Enter your name', 'error');
        if (mobile.length !== 10) return toast('Enter a valid 10-digit mobile', 'error');
        // Reject mobile that's already used by a different account
        const conflict = Store.data.users.find(u => u.mobile === mobile && u.id !== me.id);
        if (conflict) return toast('That mobile is already used by another account', 'error');
        me.name = name;
        me.mobile = mobile;
        me.address = addr;
        Store.save();
        // Refresh the session cache so the topbar greeting / avatar update immediately
        if (App.user && App.user.id === me.id) {
          App.user.name = name;
          App.user.mobile = mobile;
          App.user.address = addr;
          sessionStorage.setItem('dailywater-session', JSON.stringify(App.user));
        }
        toast('Profile saved', 'success');
        ownerSettings();
      }
    }, 'Save'));
    page.appendChild(details);
  }

  // ─── Business info ───────────────────────────────────────
  else if (_ownerSettingsSection === 'business') {
    const biz = el('div', { class: 'card' });
    biz.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Business name'),
      el('input', { class: 'input', id: 'st-bname', type: 'text', value: s.businessName || '', placeholder: 'e.g. AquaPure Waters' })
    ]));
    biz.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Address'),
      el('textarea', { class: 'input', id: 'st-baddr', rows: 2, placeholder: 'Shop address (will appear on bills)' }, s.businessAddress || '')
    ]));
    biz.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Business phone'),
      el('input', { class: 'input', id: 'st-bphone', type: 'tel', value: s.businessPhone || '', placeholder: '+91 ...' })
    ]));
    biz.appendChild(el('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => {
        s.businessName = document.getElementById('st-bname').value.trim();
        s.businessAddress = document.getElementById('st-baddr').value.trim();
        s.businessPhone = document.getElementById('st-bphone').value.trim();
        Store.save();
        toast('Saved', 'success');
      }
    }, 'Save'));
    page.appendChild(biz);
  }

  // ─── Pricing & payments ──────────────────────────────────
  else if (_ownerSettingsSection === 'pricing') {
    const gen = el('div', { class: 'card' });
    gen.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Price per litre (₹)'),
      el('input', { class: 'input', id: 'st-price', type: 'number', min: 1, value: s.pricePerLitre })
    ]));
    gen.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'UPI ID'),
      el('input', { class: 'input', id: 'st-upi', type: 'text', value: s.upiId || '' })
    ]));
    gen.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'UPI display name'),
      el('input', { class: 'input', id: 'st-upiname', type: 'text', value: s.upiName || '' })
    ]));
    gen.appendChild(el('div', { class: 'field' }, [
      el('label', {}, 'Owner WhatsApp (with country code)'),
      el('input', { class: 'input', id: 'st-wa', type: 'tel', inputmode: 'numeric', value: s.ownerWhatsApp || '' })
    ]));
    gen.appendChild(el('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => {
        const price = +document.getElementById('st-price').value;
        if (!price || price <= 0) return toast('Enter valid price', 'error');
        s.pricePerLitre = price;
        s.upiId = document.getElementById('st-upi').value.trim();
        s.upiName = document.getElementById('st-upiname').value.trim();
        s.ownerWhatsApp = document.getElementById('st-wa').value.replace(/\D/g, '');
        Store.save();
        toast('Saved', 'success');
      }
    }, 'Save'));
    page.appendChild(gen);
  }

  // ─── Delivery boys ───────────────────────────────────────
  else if (_ownerSettingsSection === 'boys') {
    page.appendChild(el('div', { class: 'section-head' }, [
      el('h2', {}, 'Delivery boys'),
      el('button', { class: 'link-btn', onclick: () => boyForm(null) }, '+ Add')
    ]));
    const myBoys = Store.data.users.filter(u => u.role === 'delivery_boy' && u.ownerId === App.user.id);
    if (myBoys.length === 0) {
      page.appendChild(el('div', { class: 'card text-muted', style: 'font-size:13px' },
        'No delivery boys yet. Add one to assign customers and track their routes.'));
    } else {
      const list = el('div', { class: 'list' });
      myBoys.forEach(b => {
        const assignedCount = Store.data.users.filter(u => u.role === 'customer' && u.ownerId === App.user.id && u.assignedBoyId === b.id).length;
        list.appendChild(el('div', { class: 'list-item is-clickable', onclick: () => boyForm(b) }, [
          avatarFor(b),
          el('div', { class: 'li-body' }, [
            el('div', { class: 'li-title' }, b.name),
            el('div', { class: 'li-sub' }, '+91 ' + b.mobile + ' · ' + assignedCount + ' assigned')
          ]),
          el('span', { class: 'icon', html: ICON.edit, style: 'opacity:.5' })
        ]));
      });
      page.appendChild(list);
    }
  }

  // ─── Holidays ────────────────────────────────────────────
  else if (_ownerSettingsSection === 'holidays') {
    page.appendChild(el('div', { class: 'section-head' }, [
      el('h2', {}, 'Holidays'),
      el('button', { class: 'link-btn', onclick: () => addHoliday() }, '+ Add')
    ]));
    const holidays = (Store.data.holidays || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (holidays.length === 0) {
      page.appendChild(el('div', { class: 'card text-muted', style: 'font-size:13px' },
        'No holidays set. Add dates when your dairy is closed (e.g. Diwali, Independence Day).'));
    } else {
      const list = el('div', { class: 'list' });
      holidays.forEach(h => {
        list.appendChild(el('div', { class: 'list-item' }, [
          el('div', { class: 'li-avatar', style: 'background:#FEF3C7;color:#92400E' }, '🗓'),
          el('div', { class: 'li-body' }, [
            el('div', { class: 'li-title' }, h.label || 'Holiday'),
            el('div', { class: 'li-sub' }, prettyDate(h.date))
          ]),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            onclick: async () => {
              if (!await confirmDialog('Remove holiday?', h.label + ' on ' + prettyDate(h.date), 'Remove')) return;
              Store.data.holidays = Store.data.holidays.filter(x => !(x.date === h.date && x.label === h.label));
              Store.save();
              await Store.removeRemote('holidays', h.date, 'date');
              ownerSettings();
            }
          }, 'Remove')
        ]));
      });
      page.appendChild(list);
    }
  }

  // ─── Products ────────────────────────────────────────────
  else if (_ownerSettingsSection === 'products') {
    page.appendChild(el('div', { class: 'section-head' }, [
      el('h2', {}, 'Products (extras)'),
      el('button', { class: 'link-btn', onclick: () => productForm(null) }, '+ Add')
    ]));
    const products = s.products;
    const entries = Object.entries(products);
    const active = entries.filter(([, p]) => p.active !== false);
    const archived = entries.filter(([, p]) => p.active === false);
    const renderRow = ([key, p]) => {
      const stock = Number(p.stock) || 0;
      const stockTag = p.active === false ? ' · archived'
        : (stock <= 0 ? ' · ⚠ out of stock' : (stock <= 5 ? ' · ⚠ low: ' + stock : ' · ' + stock + ' in stock'));
      return el('div', { class: 'list-item' + (p.active === false ? ' is-archived' : ''), onclick: () => productForm(key) }, [
        el('div', { class: 'li-avatar' }, p.emoji || '💧'),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, p.name),
          el('div', { class: 'li-sub' }, fmtMoney(p.price) + stockTag)
        ]),
        el('span', { class: 'icon', html: ICON.edit, style: 'opacity:.5' })
      ]);
    };
    if (active.length) {
      const list = el('div', { class: 'list' });
      active.forEach(e => list.appendChild(renderRow(e)));
      page.appendChild(list);
    } else {
      page.appendChild(emptyState('🛒', 'No products', 'Add a product so customers can order extras.'));
    }
    if (archived.length) {
      page.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [
        el('h2', { style: 'font-size:14px;color:var(--muted)' }, 'Archived (' + archived.length + ')')
      ]));
      const list = el('div', { class: 'list' });
      archived.forEach(e => list.appendChild(renderRow(e)));
      page.appendChild(list);
    }
  }

  // ─── Appearance / Theme ──────────────────────────────────
  else if (_ownerSettingsSection === 'theme') {
    [
      { v: 'light', l: '☀️ Light',                    h: 'Bright background, classic look' },
      { v: 'dark',  l: '🌙 Dark',                     h: 'Easier on the eyes at night' },
      { v: 'auto',  l: '⚙️ Auto · match phone',        h: 'Switches automatically with system' }
    ].forEach(opt => {
      const selected = (Store.data.theme || 'auto') === opt.v;
      page.appendChild(el('button', {
        type: 'button',
        class: 'sett-radio-row' + (selected ? ' selected' : ''),
        onclick: () => { setTheme(opt.v); ownerSettings(); }
      }, [
        el('span', { class: 'sett-radio-text' }, [
          el('span', { class: 'sett-radio-title' }, opt.l),
          el('span', { class: 'sett-radio-sub' }, opt.h)
        ]),
        el('span', { class: 'sett-radio-tick' }, selected ? '✓' : '')
      ]));
    });
  }

  // ─── Language ────────────────────────────────────────────
  else if (_ownerSettingsSection === 'lang') {
    [
      { v: 'en', l: 'English' },
      { v: 'hi', l: 'हिन्दी (Hindi)' },
      { v: 'mr', l: 'मराठी (Marathi)' }
    ].forEach(opt => {
      const selected = (Store.data.language || 'en') === opt.v;
      page.appendChild(el('button', {
        type: 'button',
        class: 'sett-radio-row' + (selected ? ' selected' : ''),
        onclick: () => { setLanguage(opt.v); ownerSettings(); }
      }, [
        el('span', { class: 'sett-radio-text' }, [
          el('span', { class: 'sett-radio-title' }, opt.l)
        ]),
        el('span', { class: 'sett-radio-tick' }, selected ? '✓' : '')
      ]));
    });
  }

  $view.appendChild(page);
}

function addHoliday() {
  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Date'),
    el('input', { class: 'input', id: 'hol-date', type: 'date', value: todayISO() })
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Label'),
    el('input', { class: 'input', id: 'hol-label', type: 'text', placeholder: 'e.g. Diwali, Independence Day', autofocus: true })
  ]));
  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block',
    onclick: () => {
      const date = document.getElementById('hol-date').value;
      const label = document.getElementById('hol-label').value.trim() || 'Holiday';
      if (!date) return toast('Pick a date', 'error');
      Store.data.holidays = Store.data.holidays || [];
      Store.data.holidays.push({ date, label });
      Store.save();
      toast('Holiday added', 'success');
      closeModal();
      ownerSettings();
    }
  }, 'Add holiday'));
  openModal('Add holiday', wrap);
}

function productForm(key) {
  const isEdit = !!key;
  const p = isEdit ? Store.data.settings.products[key] : { name: '', price: '', emoji: '💧', active: true, stock: 0 };
  if (isEdit && !p) return toast('Product not found', 'error');

  const wrap = el('div', {});

  // Emoji input + preset chips
  const emojiInput = el('input', { class: 'input', id: 'pf-emoji', type: 'text', maxlength: 4, value: p.emoji || '💧', style: 'font-size:24px;text-align:center' });
  const PRESET_EMOJIS = ['💧','🪣','🚰','🧴','🍦','🥣','🍶','🍯','🥚','🥥','🍵','☕','🥤','🍰','🍪','🥯','🍫','🌽','🍞','🍩'];
  const chipRow = el('div', { class: 'emoji-picker' },
    PRESET_EMOJIS.map(e => el('button', {
      type: 'button', class: 'emoji-chip' + (p.emoji === e ? ' active' : ''),
      onclick: () => {
        emojiInput.value = e;
        chipRow.querySelectorAll('.emoji-chip').forEach(c => c.classList.remove('active'));
        // Mark this one active
        const target = Array.from(chipRow.querySelectorAll('.emoji-chip')).find(c => c.textContent === e);
        if (target) target.classList.add('active');
      }
    }, e))
  );
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Emoji / icon'),
    emojiInput,
    chipRow
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Name'),
    el('input', { class: 'input', id: 'pf-name', type: 'text', value: p.name, autofocus: true, placeholder: 'e.g. 20L Can' })
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Price (₹)'),
    el('input', { class: 'input', id: 'pf-price', type: 'number', min: 1, value: p.price, placeholder: '110' })
  ]));
  wrap.appendChild(el('div', { class: 'field' }, [
    el('label', {}, 'Stock (available units)'),
    el('input', { class: 'input', id: 'pf-stock', type: 'number', min: 0, value: Number(p.stock) || 0, placeholder: '0' })
  ]));

  if (isEdit) {
    const toggle = el('label', { class: 'switch-row' }, [
      el('span', {}, p.active === false ? 'Archived (hidden from customers)' : 'Active'),
      el('input', { id: 'pf-active', type: 'checkbox', checked: p.active !== false })
    ]);
    wrap.appendChild(toggle);
  }

  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:8px',
    onclick: () => save()
  }, isEdit ? 'Save changes' : 'Add product'));

  // Show recent customer ratings if any
  if (isEdit) {
    const ratings = (Store.data.productRatings || []).filter(r => r.productKey === key)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (ratings.length) {
      const avg = ratings.reduce((s, r) => s + r.rating, 0) / ratings.length;
      wrap.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [
        el('h2', { style: 'font-size:14px' }, 'Customer ratings — ★ ' + avg.toFixed(1) + ' (' + ratings.length + ')')
      ]));
      const rList = el('div', { class: 'list', style: 'max-height:220px;overflow-y:auto' });
      ratings.slice(0, 10).forEach(r => {
        const c = Store.data.users.find(u => u.id === r.customerId);
        rList.appendChild(el('div', { class: 'list-item' }, [
          el('div', { class: 'li-body' }, [
            el('div', { class: 'li-title', style: 'font-size:13px' }, (c?.name || 'Customer') + ' · ' + '★'.repeat(r.rating) + (r.rating < 5 ? '☆'.repeat(5 - r.rating) : '')),
            r.review ? el('div', { class: 'li-sub', style: 'font-size:12px' }, '"' + r.review + '"') : null,
            el('div', { class: 'text-muted', style: 'font-size:11px;margin-top:2px' }, prettyDate(String(r.date).slice(0, 10)))
          ])
        ]));
      });
      wrap.appendChild(rList);
    }

    wrap.appendChild(el('button', {
      class: 'btn btn-danger btn-block', style: 'margin-top:8px',
      onclick: async () => {
        const usedBy = Store.data.extraOrders.filter(o => o.productKey === key).length;
        if (usedBy > 0) {
          if (!await confirmDialog('Archive product?',
            p.name + ' has ' + usedBy + ' past order(s). Archiving hides it from customers but keeps history. To permanently delete it would break those records.',
            'Archive')) return;
          p.active = false;
          Store.save();
          toast('Archived');
          closeModal();
          ownerSettings();
        } else {
          if (!await confirmDialog('Delete product?', p.name + ' will be removed.', 'Delete')) return;
          delete Store.data.settings.products[key];
          const ratingIds = (Store.data.productRatings || []).filter(r => r.productKey === key).map(r => r.id);
          Store.data.productRatings = (Store.data.productRatings || []).filter(r => r.productKey !== key);
          Store.save();
          await Promise.all([
            Store.removeRemote('products', key, 'key'),
            Store.removeRemote('product_ratings', ratingIds)
          ]);
          toast('Deleted');
          closeModal();
          ownerSettings();
        }
      }
    }, Store.data.extraOrders.some(o => o.productKey === key) ? 'Archive product' : 'Delete product'));
  }

  function save() {
    const emoji = document.getElementById('pf-emoji').value.trim() || '💧';
    const name = document.getElementById('pf-name').value.trim();
    const price = +document.getElementById('pf-price').value;
    const stock = Math.max(0, +document.getElementById('pf-stock').value || 0);
    if (!name) return toast('Enter name', 'error');
    if (!price || price <= 0) return toast('Enter valid price', 'error');

    if (isEdit) {
      const active = document.getElementById('pf-active').checked;
      Object.assign(p, { name, price, emoji, active, stock });
    } else {
      const newKey = uniqueProductKey(slugify(name));
      Store.data.settings.products[newKey] = { name, price, emoji, active: true, stock };
    }
    Store.save();
    toast(isEdit ? 'Product updated' : 'Product added', 'success');
    closeModal();
    ownerSettings();
  }

  openModal(isEdit ? 'Edit product' : 'Add product', wrap);
}

/* ─── Owner: orders inbox ─────────────────────────────────── */
function ownerOrdersInbox(filter) {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  const back = () => { document.body.classList.remove('no-tabs'); $tabbar.hidden = false; viewOwner(); };
  $view.appendChild(topbar({ title: 'Orders', subtitle: 'Extras orders inbox', back, bell: true }));

  const page = el('div', { class: 'page' });
  const all = Store.data.extraOrders.slice().sort((a, b) => b.date.localeCompare(a.date));
  const counts = {
    pending:   all.filter(o => o.status === 'pending').length,
    confirmed: all.filter(o => o.status === 'confirmed').length,
    delivered: all.filter(o => o.status === 'delivered').length,
    cancelled: all.filter(o => o.status === 'cancelled').length,
    all: all.length
  };
  const current = filter || 'pending';

  // Filter chips
  const chipRow = el('div', { class: 'chip-row' });
  [['pending','Pending'], ['confirmed','Confirmed'], ['delivered','Delivered'], ['cancelled','Cancelled'], ['all','All']]
    .forEach(([k, label]) => chipRow.appendChild(el('button', {
      class: 'chip' + (current === k ? ' active' : ''),
      onclick: () => ownerOrdersInbox(k)
    }, label + ' (' + counts[k] + ')')));
  page.appendChild(chipRow);

  const items = current === 'all' ? all : all.filter(o => o.status === current);
  if (items.length === 0) {
    page.appendChild(emptyState('🛒', 'No orders', current === 'pending' ? 'No new orders to review.' : 'No orders in this state.'));
  } else {
    const list = el('div', { class: 'list' });
    items.forEach(o => {
      const p = Store.data.settings.products[o.productKey];
      const c = Store.data.users.find(u => u.id === o.customerId);
      list.appendChild(el('div', { class: 'list-item is-clickable', onclick: () => ownerOrderManage(o.id) }, [
        el('div', { class: 'li-avatar' }, p?.emoji || '💧'),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, (c?.name || 'Customer') + ' — ' + (p?.name || 'Removed item') + ' × ' + o.qty),
          el('div', { class: 'li-sub' }, prettyDate(o.date.slice(0, 10)) + ' · ' + fmtMoney((p?.price || 0) * o.qty))
        ]),
        el('span', { class: 'badge ' + (o.status === 'delivered' ? 'success' : o.status === 'cancelled' ? 'danger' : o.status === 'confirmed' ? 'info' : 'warn') }, o.status)
      ]));
    });
    page.appendChild(list);
  }

  $view.appendChild(page);
}

function ownerOrderManage(orderId) {
  const o = Store.data.extraOrders.find(x => x.id === orderId);
  if (!o) return;
  const p = Store.data.settings.products[o.productKey];
  const c = Store.data.users.find(u => u.id === o.customerId);

  const wrap = el('div', {});
  wrap.appendChild(el('div', { class: 'text-center', style: 'font-size:48px' }, p?.emoji || '💧'));
  wrap.appendChild(el('div', { class: 'text-center', style: 'font-weight:700;margin-top:6px' }, p?.name || 'Removed item'));
  wrap.appendChild(el('div', { class: 'text-center text-muted' }, '× ' + o.qty + ' · ' + fmtMoney((p?.price || 0) * o.qty)));
  wrap.appendChild(el('div', { class: 'card', style: 'margin:12px 0' }, [
    el('div', { class: 'row', style: 'justify-content:space-between' }, [el('span', { class: 'text-muted' }, 'Customer'), el('span', { style: 'font-weight:600' }, c?.name || '—')]),
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, [el('span', { class: 'text-muted' }, 'Mobile'), el('span', { class: 'text-mono' }, c?.mobile || '—')]),
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, [el('span', { class: 'text-muted' }, 'Placed'), el('span', {}, prettyDate(o.date.slice(0, 10)))]),
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, [el('span', { class: 'text-muted' }, 'Status'), el('span', { class: 'badge ' + (o.status === 'delivered' ? 'success' : o.status === 'cancelled' ? 'danger' : o.status === 'confirmed' ? 'info' : 'warn') }, o.status)])
  ]));

  const refresh = () => { Store.save(); closeModal(); ownerOrdersInbox(o.status === 'cancelled' ? 'cancelled' : o.status); };

  if (o.status === 'pending') {
    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:8px',
      onclick: () => {
        o.status = 'confirmed';
        notify(o.customerId, 'order', 'Order confirmed', (p?.name || 'Order') + ' × ' + o.qty + ' confirmed by owner.');
        toast('Order confirmed', 'success');
        refresh();
      }
    }, 'Confirm order'));
  }
  if (o.status === 'pending' || o.status === 'confirmed') {
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
      onclick: () => {
        o.status = 'delivered';
        notify(o.customerId, 'order', 'Order delivered', (p?.name || 'Order') + ' × ' + o.qty + ' delivered.');
        toast('Marked delivered', 'success');
        refresh();
      }
    }, 'Mark delivered'));
    wrap.appendChild(el('button', {
      class: 'btn btn-danger btn-block', style: 'margin-top:8px',
      onclick: async () => {
        if (!await confirmDialog('Cancel order?', (p?.name || 'Order') + ' × ' + o.qty + ' for ' + (c?.name || 'customer'), 'Cancel order')) return;
        // Refund reserved stock back to product
        if (p) Store.data.settings.products[o.productKey].stock = (Number(p.stock) || 0) + o.qty;
        o.status = 'cancelled';
        notify(o.customerId, 'order', 'Order cancelled', (p?.name || 'Order') + ' × ' + o.qty + ' cancelled by owner.');
        toast('Order cancelled');
        refresh();
      }
    }, 'Cancel order'));
  }

  openModal('Manage order', wrap);
}

/* ─── Owner: procurement detail ───────────────────────────── */
function ownerProcurementDetail() {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  const back = () => { document.body.classList.remove('no-tabs'); $tabbar.hidden = false; viewOwner(); };

  const tomDate = new Date(); tomDate.setDate(tomDate.getDate() + 1);
  const tomISO = tomDate.toISOString().slice(0, 10);
  const holiday = getHoliday(tomISO);
  const customers = getCustomers();

  $view.appendChild(topbar({
    title: 'Procurement plan', subtitle: 'Tomorrow · ' + prettyDate(tomISO), back,
    right: el('button', { class: 'icon-btn', onclick: () => window.print(), 'aria-label': 'Print',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>' })
  }));

  const page = el('div', { class: 'page printable' });
  page.appendChild(el('div', { class: 'print-only print-header' }, [
    el('h1', {}, 'DailyWater — Procurement plan'),
    el('div', { class: 'text-muted' }, prettyDate(tomISO) + ' · Printed ' + new Date().toLocaleString('en-IN'))
  ]));

  if (holiday) {
    page.appendChild(el('div', { class: 'card', style: 'background:#FEF3C7' }, [
      el('div', { style: 'font-weight:700;font-size:16px' }, '🗓️ Holiday: ' + holiday.label),
      el('div', { class: 'text-muted', style: 'font-size:13px;margin-top:4px' }, 'No deliveries scheduled.')
    ]));
    $view.appendChild(page);
    return;
  }

  const active = customers.filter(c => !isPaused(c.id, tomISO));
  const paused = customers.filter(c => isPaused(c.id, tomISO));
  const totalMl = active.reduce((s, c) => s + (c.dailyMl || 0), 0);

  // Bucket by quantity for quick inventory plan
  const buckets = {};
  active.forEach(c => { buckets[c.dailyMl] = (buckets[c.dailyMl] || 0) + 1; });

  page.appendChild(el('div', { class: 'hero-stat' }, [
    el('div', { class: 'hero-stat-label' }, 'Tomorrow procurement'),
    el('div', { class: 'hero-stat-value' }, fmtQty(totalMl)),
    el('div', { class: 'hero-stat-foot' }, active.length + ' customer' + (active.length === 1 ? '' : 's') + (paused.length ? ' · ' + paused.length + ' paused' : ''))
  ]));

  // Buckets
  if (Object.keys(buckets).length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [el('h2', {}, 'By quantity')]));
    page.appendChild(reportTable(['Per customer', 'Customers', 'Total water'],
      Object.entries(buckets).sort(([a], [b]) => +b - +a).map(([qty, count]) => [
        fmtQty(+qty), String(count), fmtQty(+qty * count)
      ])));
  }

  // Customer list
  page.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [el('h2', {}, 'Customer list')]));
  page.appendChild(reportTable(['#', 'Customer', 'Quantity', 'Address'],
    active.map((c, i) => [String(i + 1), c.name, fmtQty(c.dailyMl), c.address || '—'])));

  if (paused.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:14px' }, [el('h2', { style: 'color:var(--text-muted)' }, 'Paused (' + paused.length + ')')]));
    page.appendChild(reportTable(['Customer', 'Plan'],
      paused.map(c => [c.name, c.plan])));
  }

  $view.appendChild(page);
}

/* ─── Owner: stat drill-down + print ──────────────────────── */
function ownerStatDetail(kind) {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  const back = () => { document.body.classList.remove('no-tabs'); $tabbar.hidden = false; viewOwner(); };

  const today = todayISO();
  const month = monthKey();
  const customers = getCustomers();

  const titles = {
    today:     { title: 'Today delivered', sub: prettyDate(today) },
    customers: { title: 'Active customers', sub: customers.length + ' total' },
    revenue:   { title: 'Month revenue', sub: prettyMonth(month) },
    dues:      { title: 'Pending dues', sub: prettyMonth(month) }
  };
  const meta = titles[kind] || { title: 'Details' };

  $view.appendChild(topbar({
    title: meta.title, subtitle: meta.sub, back,
    right: el('button', { class: 'icon-btn', onclick: () => window.print(), 'aria-label': 'Print',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>' })
  }));

  const page = el('div', { class: 'page printable' });
  page.appendChild(el('div', { class: 'print-only print-header' }, [
    el('h1', {}, 'DailyWater — ' + meta.title),
    el('div', { class: 'text-muted' }, meta.sub + ' · Printed ' + new Date().toLocaleString('en-IN'))
  ]));

  if (kind === 'today') {
    const rows = customers.map(c => {
      const paused = isPaused(c.id, today);
      const d = getDelivery(c.id, today);
      const status = paused ? 'Paused' : (d?.status === 'delivered' ? 'Delivered' : d?.status === 'skipped' ? 'Skipped' : 'Pending');
      return { c, status, ml: d?.status === 'delivered' ? d.ml : 0 };
    });
    const totalMl = rows.reduce((s, r) => s + r.ml, 0);
    const deliveredCount = rows.filter(r => r.status === 'Delivered').length;
    page.appendChild(summaryRow([
      ['Delivered', deliveredCount + ' / ' + customers.length],
      ['Volume', fmtQty(totalMl)]
    ]));
    page.appendChild(reportTable(['#', 'Customer', 'Mobile', 'Qty', 'Status'],
      rows.map((r, i) => [String(i + 1), r.c.name, r.c.mobile, r.ml ? fmtQty(r.ml) : '—', r.status])));
  }

  else if (kind === 'customers') {
    page.appendChild(summaryRow([
      ['Total', String(customers.length)],
      ['Daily volume', fmtQty(customers.reduce((s, c) => s + (c.dailyMl || 0), 0))]
    ]));
    page.appendChild(reportTable(['#', 'Name', 'Mobile', 'Plan', 'Address'],
      customers.map((c, i) => [String(i + 1), c.name, c.mobile, c.plan, c.address || '—'])));
  }

  else if (kind === 'revenue') {
    const bills = customers.map(c => ({ c, b: customerMonthBill(c.id, month) })).sort((a, b) => b.b.total - a.b.total);
    const totalRev = bills.reduce((s, x) => s + x.b.total, 0);
    const totalPaid = bills.reduce((s, x) => s + x.b.paid, 0);
    const totalDue = bills.reduce((s, x) => s + x.b.due, 0);
    page.appendChild(summaryRow([
      ['Revenue', fmtMoney(totalRev)],
      ['Collected', fmtMoney(totalPaid)],
      ['Outstanding', fmtMoney(totalDue)]
    ]));
    page.appendChild(reportTable(['#', 'Customer', 'Days', 'Volume', 'Water', 'Extras', 'Total', 'Due'],
      bills.map((x, i) => ({
        cells: [
          String(i + 1), x.c.name, String(x.b.deliveries),
          fmtQty(x.b.totalMl), fmtMoney(x.b.milkAmt), fmtMoney(x.b.extraAmt),
          fmtMoney(x.b.total), fmtMoney(x.b.due)
        ],
        onclick: () => ownerCustomerMonth(x.c.id, month)
      }))));
  }

  else if (kind === 'dues') {
    const dues = customers.map(c => ({ c, b: customerMonthBill(c.id, month) }))
      .filter(x => x.b.due > 0).sort((a, b) => b.b.due - a.b.due);
    const totalDue = dues.reduce((s, x) => s + x.b.due, 0);
    page.appendChild(summaryRow([
      ['Customers with dues', String(dues.length)],
      ['Total outstanding', fmtMoney(totalDue)]
    ]));
    if (dues.length === 0) {
      page.appendChild(emptyState('✓', 'All settled', 'No pending dues for ' + prettyMonth(month) + '.'));
    } else {
      page.appendChild(reportTable(['#', 'Customer', 'Mobile', 'Total bill', 'Paid', 'Due'],
        dues.map((x, i) => ({
          cells: [String(i + 1), x.c.name, x.c.mobile, fmtMoney(x.b.total), fmtMoney(x.b.paid), fmtMoney(x.b.due)],
          onclick: () => ownerCustomerMonth(x.c.id, month)
        }))));
    }
  }

  $view.appendChild(page);
}

function summaryRow(pairs) {
  return el('div', { class: 'stat-grid', style: 'margin-bottom:12px' },
    pairs.map(([label, value]) => el('div', { class: 'stat' }, [
      el('div', { class: 'stat-label' }, label),
      el('div', { class: 'stat-value' }, value)
    ])));
}

function reportTable(headers, rows) {
  const wrap = el('div', { class: 'report-table-wrap' });
  const table = el('table', { class: 'report-table' });
  const thead = el('thead', {}, [el('tr', {}, headers.map(h => el('th', {}, h)))]);
  const tbody = el('tbody', {}, rows.map(r => {
    const cells = Array.isArray(r) ? r : r.cells;
    const onclick = Array.isArray(r) ? null : r.onclick;
    return el('tr', {
      class: onclick ? 'is-clickable' : '',
      onclick: onclick || null
    }, cells.map(c => el('td', {}, String(c))));
  }));
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function ownerCustomerMonth(customerId, month) {
  const c = getCustomer(customerId);
  if (!c) return;
  const b = customerMonthBill(customerId, month);
  const products = Store.data.settings.products;

  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  const back = () => { document.body.classList.remove('no-tabs'); $tabbar.hidden = false; ownerStatDetail('revenue'); };

  $view.appendChild(topbar({
    title: c.name, subtitle: prettyMonth(month) + ' · ' + c.plan, back,
    right: el('button', { class: 'icon-btn', onclick: () => window.print(), 'aria-label': 'Print',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>' })
  }));

  const page = el('div', { class: 'page printable' });

  // Print header
  page.appendChild(el('div', { class: 'print-only print-header' }, [
    el('h1', {}, 'DailyWater — ' + c.name),
    el('div', { class: 'text-muted' }, prettyMonth(month) + ' · ' + (c.address || '+91 ' + c.mobile) + ' · Printed ' + new Date().toLocaleString('en-IN'))
  ]));

  // Customer info card
  page.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'row', style: 'justify-content:space-between' }, [el('span', { class: 'text-muted' }, 'Mobile'), el('span', { class: 'text-mono' }, '+91 ' + c.mobile)]),
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, [el('span', { class: 'text-muted' }, 'Address'), el('span', { style: 'text-align:right;max-width:60%' }, c.address || '—')]),
    el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, [el('span', { class: 'text-muted' }, 'Plan'), el('span', {}, c.plan + ' · ' + fmtQty(c.dailyMl))])
  ]));

  // Summary stats
  page.appendChild(summaryRow([
    ['Days delivered', String(b.deliveries)],
    ['Total volume', fmtQty(b.totalMl)],
    ['Total bill', fmtMoney(b.total)],
    ['Due', fmtMoney(b.due)]
  ]));

  // Daily delivery log
  const monthDeliveries = Store.data.deliveries
    .filter(d => d.customerId === customerId && d.date.startsWith(month))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (monthDeliveries.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:12px' }, [el('h2', {}, 'Delivery log')]));
    page.appendChild(reportTable(
      ['Date', 'Status', 'Quantity'],
      monthDeliveries.map(d => [
        prettyDate(d.date),
        d.status === 'delivered' ? 'Delivered' : d.status === 'skipped' ? 'Skipped' : 'Pending',
        d.status === 'delivered' ? fmtQty(d.ml) : '—'
      ])
    ));
  }

  // Extras
  if (b.extras.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:12px' }, [el('h2', {}, 'Extras')]));
    page.appendChild(reportTable(
      ['Date', 'Product', 'Qty', 'Price', 'Amount'],
      b.extras.map(o => {
        const p = products[o.productKey];
        return [
          prettyDate(o.date.slice(0, 10)),
          p?.name || 'Removed item',
          String(o.qty),
          fmtMoney(p?.price || 0),
          fmtMoney((p?.price || 0) * o.qty)
        ];
      })
    ));
  }

  // Photo gallery (delivery proofs)
  const photos = monthDeliveries.filter(d => d.photo);
  if (photos.length) {
    page.appendChild(el('div', { class: 'section-head no-print', style: 'margin-top:12px' }, [
      el('h2', {}, 'Delivery photos'),
      el('span', { class: 'text-muted', style: 'font-size:13px' }, photos.length + ' photo' + (photos.length === 1 ? '' : 's'))
    ]));
    const grid = el('div', { class: 'photo-grid no-print' });
    photos.forEach(d => {
      grid.appendChild(el('div', { class: 'photo-tile', onclick: () => viewPhoto(d.photo) }, [
        el('img', { src: d.photo, alt: 'Delivery on ' + prettyDate(d.date) }),
        el('div', { class: 'photo-tile-date' }, prettyDate(d.date))
      ]));
    });
    page.appendChild(grid);
  }

  // Bill breakdown
  page.appendChild(el('div', { class: 'section-head', style: 'margin-top:12px' }, [el('h2', {}, 'Bill summary')]));
  page.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'bill-rows' }, [
      el('div', { class: 'bill-row' }, [el('span', {}, 'Milk @ ' + fmtMoney(Store.data.settings.pricePerLitre) + '/L'), el('span', { class: 'text-mono' }, fmtMoney(b.milkAmt))]),
      el('div', { class: 'bill-row' }, [el('span', {}, 'Extras'), el('span', { class: 'text-mono' }, fmtMoney(b.extraAmt))]),
      b.paid > 0 ? el('div', { class: 'bill-row' }, [el('span', {}, 'Paid'), el('span', { class: 'text-mono', style: 'color:var(--success)' }, '− ' + fmtMoney(b.paid))]) : null,
      el('div', { class: 'bill-row total' }, [el('span', {}, b.due > 0 ? 'Amount due' : 'Total'), el('span', { class: 'text-mono' }, fmtMoney(b.due > 0 ? b.due : b.total))])
    ])
  ]));

  // Quick actions (hidden in print)
  if (b.total > 0) {
    page.appendChild(el('div', { class: 'no-print', style: 'margin-top:14px' }, [
      el('button', {
        class: 'btn btn-primary btn-block',
        onclick: () => previewBillPDF(c, b, month)
      }, '📄 Preview & Send PDF'),
      el('a', {
        class: 'btn btn-ghost btn-block', style: 'margin-top:8px',
        href: waLink(c.mobile, billWhatsAppMessage(c, b, prettyMonth(month))),
        target: '_blank', rel: 'noopener'
      }, '💬 WhatsApp text only')
    ]));
  }

  $view.appendChild(page);
}

/* ─── PDF bill generation ─────────────────────────────────── */

function numberToIndianWords(num) {
  num = Math.round(num);
  if (num === 0) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigit = (n) => n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  const threeDigit = (n) => {
    let s = '';
    if (n >= 100) { s += ones[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) s += ' '; }
    if (n) s += twoDigit(n);
    return s;
  };
  let s = '';
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh  = Math.floor(num / 100000);   num %= 100000;
  const thou  = Math.floor(num / 1000);     num %= 1000;
  if (crore) s += threeDigit(crore) + ' Crore ';
  if (lakh)  s += twoDigit(lakh) + ' Lakh ';
  if (thou)  s += twoDigit(thou) + ' Thousand ';
  if (num)   s += threeDigit(num);
  return s.trim() + ' Rupees Only';
}

function generateBillPDF(customer, bill, monthIso) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast('PDF library not loaded yet — try again in a moment', 'error');
    return null;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const s = Store.data.settings;
  const products = s.products;
  const monthLabel = prettyMonth(monthIso);
  const billDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const billNo = 'MM-' + monthIso + '-' + customer.id.slice(0, 4).toUpperCase();

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = margin;

  // Header band
  doc.setFillColor(0, 135, 90);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(s.businessName || 'DailyWater', margin, 11);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (s.businessAddress) doc.text(s.businessAddress.split('\n').join(' · '), margin, 17);
  const contactBits = [];
  if (s.businessPhone) contactBits.push('Phone: ' + s.businessPhone);
  if (s.upiId) contactBits.push('UPI: ' + s.upiId);
  if (contactBits.length) doc.text(contactBits.join('  ·  '), margin, 23);

  doc.setTextColor(0, 0, 0);
  y = 38;

  // Bill # and date (right side)
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('BILL', pageW - margin, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Bill #: ' + billNo, pageW - margin, y + 5, { align: 'right' });
  doc.text('Date: ' + billDate, pageW - margin, y + 10, { align: 'right' });
  doc.text('Period: ' + monthLabel, pageW - margin, y + 15, { align: 'right' });

  // Bill To
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Bill To:', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(customer.name, margin, y + 6);
  doc.setFontSize(9);
  let lineY = y + 11;
  if (customer.address) {
    doc.text(customer.address, margin, lineY, { maxWidth: 90 });
    lineY += 5;
  }
  doc.text('+91 ' + customer.mobile, margin, lineY);
  lineY += 5;
  if (customer.plan) doc.text('Plan: ' + customer.plan, margin, lineY);

  y = Math.max(y + 22, lineY + 4);

  // Line items table
  const rows = [];
  let idx = 1;
  if (bill.totalMl > 0) {
    rows.push([
      idx++,
      'Milk delivery (' + monthLabel + ')',
      bill.deliveries + ' days',
      fmtQty(bill.totalMl),
      'Rs. ' + s.pricePerLitre + ' / L',
      'Rs. ' + Math.round(bill.milkAmt).toLocaleString('en-IN')
    ]);
  }
  bill.extras.forEach(o => {
    const p = products[o.productKey];
    rows.push([
      idx++,
      p?.name || 'Removed item',
      prettyDate(o.date.slice(0, 10)),
      String(o.qty),
      'Rs. ' + (p?.price || 0),
      'Rs. ' + Math.round((p?.price || 0) * o.qty).toLocaleString('en-IN')
    ]);
  });

  doc.autoTable({
    startY: y,
    head: [['#', 'Particulars', 'When', 'Qty', 'Rate', 'Amount']],
    body: rows,
    theme: 'grid',
    headStyles: { fillColor: [0, 135, 90], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 9, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      3: { halign: 'center' },
      4: { halign: 'right' },
      5: { halign: 'right' }
    },
    margin: { left: margin, right: margin }
  });

  let endY = doc.lastAutoTable.finalY + 4;

  // Totals box
  const totalsX = pageW - margin - 70;
  const drawTotal = (label, value, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(bold ? 11 : 9);
    doc.text(label, totalsX, endY);
    doc.text(value, pageW - margin, endY, { align: 'right' });
    endY += bold ? 7 : 5;
  };
  drawTotal('Subtotal', 'Rs. ' + Math.round(bill.total).toLocaleString('en-IN'));
  if (bill.paid > 0) drawTotal('Paid', '- Rs. ' + Math.round(bill.paid).toLocaleString('en-IN'));
  doc.setDrawColor(150);
  doc.line(totalsX, endY - 2, pageW - margin, endY - 2);
  endY += 1;
  drawTotal(bill.due > 0 ? 'Amount Due' : 'Total', 'Rs. ' + Math.round(bill.due > 0 ? bill.due : bill.total).toLocaleString('en-IN'), true);

  // Amount in words
  endY += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Amount in words:', margin, endY);
  doc.setFont('helvetica', 'normal');
  endY += 5;
  const wordsText = numberToIndianWords(bill.due > 0 ? bill.due : bill.total);
  const wordsLines = doc.splitTextToSize(wordsText, pageW - 2 * margin);
  doc.text(wordsLines, margin, endY);
  endY += wordsLines.length * 5;

  // Footer
  const footerY = doc.internal.pageSize.getHeight() - 22;
  doc.setDrawColor(200);
  doc.line(margin, footerY, pageW - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (bill.due > 0 && s.upiId) {
    doc.setFont('helvetica', 'bold');
    doc.text('Pay via UPI: ' + s.upiId, margin, footerY + 5);
    doc.setFont('helvetica', 'normal');
  }
  doc.text('Thank you for your business!', margin, footerY + 11);
  doc.setFontSize(7);
  doc.setTextColor(120);
  doc.text('Generated by DailyWater', pageW - margin, footerY + 11, { align: 'right' });

  return {
    blob: doc.output('blob'),
    dataUrl: doc.output('datauristring'),
    filename: 'Bill_' + customer.name.replace(/\s+/g, '_') + '_' + monthIso + '.pdf'
  };
}

function renderBillPreviewHtml(customer, bill, monthIso) {
  const s = Store.data.settings;
  const products = s.products;
  const monthLabel = prettyMonth(monthIso);
  const billDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const billNo = 'MM-' + monthIso + '-' + customer.id.slice(0, 4).toUpperCase();
  const wrap = el('div', { class: 'bill-preview' });

  // Header band
  const header = el('div', { class: 'bill-header' });
  header.appendChild(el('div', { class: 'bill-business-name' }, s.businessName || 'DailyWater'));
  if (s.businessAddress) header.appendChild(el('div', { class: 'bill-business-meta' }, s.businessAddress.split('\n').join(' · ')));
  const contactBits = [];
  if (s.businessPhone) contactBits.push('📞 ' + s.businessPhone);
  if (s.upiId) contactBits.push('UPI: ' + s.upiId);
  if (contactBits.length) header.appendChild(el('div', { class: 'bill-business-meta' }, contactBits.join('  ·  ')));
  wrap.appendChild(header);

  // Bill # and customer
  const meta = el('div', { class: 'bill-meta' });
  meta.appendChild(el('div', { class: 'bill-bill-to' }, [
    el('div', { class: 'bill-label' }, 'Bill To:'),
    el('div', { class: 'bill-customer-name' }, customer.name),
    customer.address ? el('div', { class: 'bill-customer-line' }, customer.address) : null,
    el('div', { class: 'bill-customer-line' }, '+91 ' + customer.mobile),
    customer.plan ? el('div', { class: 'bill-customer-line' }, 'Plan: ' + customer.plan) : null
  ]));
  meta.appendChild(el('div', { class: 'bill-bill-no' }, [
    el('div', { class: 'bill-doc-title' }, 'BILL'),
    el('div', { class: 'bill-meta-line' }, '#' + billNo),
    el('div', { class: 'bill-meta-line' }, billDate),
    el('div', { class: 'bill-meta-line' }, monthLabel)
  ]));
  wrap.appendChild(meta);

  // Line items table
  const table = el('table', { class: 'bill-table' });
  const thead = el('thead', {}, [el('tr', {}, [
    el('th', {}, '#'),
    el('th', {}, 'Particulars'),
    el('th', {}, 'When'),
    el('th', { class: 'num' }, 'Qty'),
    el('th', { class: 'num' }, 'Rate'),
    el('th', { class: 'num' }, 'Amount')
  ])]);
  const tbody = el('tbody', {});
  let idx = 1;
  if (bill.totalMl > 0) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, String(idx++)),
      el('td', {}, 'Milk delivery (' + monthLabel + ')'),
      el('td', {}, bill.deliveries + ' days'),
      el('td', { class: 'num' }, fmtQty(bill.totalMl)),
      el('td', { class: 'num' }, '₹' + s.pricePerLitre + '/L'),
      el('td', { class: 'num' }, fmtMoney(bill.milkAmt))
    ]));
  }
  bill.extras.forEach(o => {
    const p = products[o.productKey];
    tbody.appendChild(el('tr', {}, [
      el('td', {}, String(idx++)),
      el('td', {}, p?.name || 'Removed item'),
      el('td', {}, prettyDate(o.date.slice(0, 10))),
      el('td', { class: 'num' }, String(o.qty)),
      el('td', { class: 'num' }, fmtMoney(p?.price || 0)),
      el('td', { class: 'num' }, fmtMoney((p?.price || 0) * o.qty))
    ]));
  });
  table.appendChild(thead); table.appendChild(tbody);
  wrap.appendChild(table);

  // Totals
  const totals = el('div', { class: 'bill-totals' });
  totals.appendChild(el('div', { class: 'bill-total-row' }, [el('span', {}, 'Subtotal'), el('span', {}, fmtMoney(bill.total))]));
  if (bill.paid > 0) totals.appendChild(el('div', { class: 'bill-total-row' }, [el('span', {}, 'Paid'), el('span', { style: 'color:var(--success)' }, '− ' + fmtMoney(bill.paid))]));
  totals.appendChild(el('div', { class: 'bill-total-row total' }, [
    el('span', {}, bill.due > 0 ? 'Amount Due' : 'Total'),
    el('span', {}, fmtMoney(bill.due > 0 ? bill.due : bill.total))
  ]));
  wrap.appendChild(totals);

  // Amount in words
  wrap.appendChild(el('div', { class: 'bill-words' }, [
    el('div', { class: 'bill-label' }, 'Amount in words:'),
    el('div', {}, numberToIndianWords(bill.due > 0 ? bill.due : bill.total))
  ]));

  // Footer
  const footer = el('div', { class: 'bill-footer' });
  if (bill.due > 0 && s.upiId) footer.appendChild(el('div', { style: 'font-weight:700' }, 'Pay via UPI: ' + s.upiId));
  footer.appendChild(el('div', {}, 'Thank you for your business! 💧'));
  footer.appendChild(el('div', { class: 'bill-brand' }, 'Generated by DailyWater'));
  wrap.appendChild(footer);

  return wrap;
}

function previewBillPDF(customer, bill, monthIso) {
  const monthLabel = prettyMonth(monthIso);
  const message = billWhatsAppMessage(customer, bill, monthLabel);

  const wrap = el('div', {});
  // HTML preview (looks like the PDF; works on Android where iframe-PDF fails)
  wrap.appendChild(renderBillPreviewHtml(customer, bill, monthIso));

  const generatePdf = () => {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast('PDF library not loaded yet — try again in a moment', 'error');
      return null;
    }
    return generateBillPDF(customer, bill, monthIso);
  };

  const actions = el('div', { class: 'bill-actions' });

  actions.appendChild(el('button', {
    class: 'btn btn-primary btn-block',
    onclick: async () => {
      const result = generatePdf(); if (!result) return;
      const { blob, filename } = result;
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'DailyWater Bill', text: message });
          toast('Shared', 'success');
          closeModal();
        } catch (e) {
          if (e.name !== 'AbortError') toast('Share failed', 'error');
        }
      } else {
        triggerDownload(blob, filename);
        setTimeout(() => {
          window.open(waLink(customer.mobile, message + '\n\n(PDF bill saved to your device — attach it in WhatsApp)'), '_blank');
        }, 400);
        toast('PDF saved — attach it in WhatsApp', 'success');
        closeModal();
      }
    }
  }, '💬 Send via WhatsApp'));

  actions.appendChild(el('button', {
    class: 'btn btn-ghost btn-block',
    onclick: () => {
      const result = generatePdf(); if (!result) return;
      triggerDownload(result.blob, result.filename);
      toast('Downloaded', 'success');
    }
  }, '⬇ Download PDF'));

  wrap.appendChild(actions);
  openModal('Bill preview — ' + customer.name, wrap);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/* ─── Delivery Boy dashboard ───────────────────────────────── */
function viewDeliveryBoy() {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  $view.appendChild(topbar({
    title: t('today'),
    subtitle: App.user.name + ' · ' + getCustomers().filter(c => c.assignedBoyId === App.user.id).length + ' stops',
    bell: true, logout: true,
    right: el('button', {
      class: 'icon-btn', 'aria-label': t('print_route'),
      onclick: () => printRouteSheet(App.user.id),
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>'
    })
  }));
  // Render the same delivery list as owner today, scoped to assigned customers
  const today = todayISO();
  const customers = getCustomers().filter(c => c.assignedBoyId === App.user.id);
  const page = el('div', { class: 'page' });

  if (customers.length === 0) {
    page.appendChild(emptyState('🚚', 'No stops today', 'No customers assigned to you yet.'));
    $view.appendChild(page);
    return;
  }

  // Free Google Maps navigation for the whole route (no API key/billing — just a deep link).
  // Stops are passed in list order; Maps can re-optimise on the device.
  const navStops = customers.filter(c => c.address && !isPaused(c.id, today));
  if (navStops.length) {
    const pts = navStops.map(c => encodeURIComponent(c.address));
    const dest = pts[pts.length - 1];
    const waypoints = pts.slice(0, -1).slice(0, 9).join('%7C'); // cap at 9 waypoints (URL limit)
    const routeUrl = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + dest +
      (waypoints ? '&waypoints=' + waypoints : '');
    page.appendChild(el('a', {
      class: 'btn btn-primary btn-block', style: 'margin-bottom:14px',
      href: routeUrl, target: '_blank', rel: 'noopener'
    }, '🧭 Navigate route · ' + navStops.length + ' stops'));
  }

  const list = el('div', { class: 'list' });
  customers.forEach(c => {
    const paused = isPaused(c.id, today);
    const row = getDelivery(c.id, today);
    const status = paused ? 'paused' : (row?.status || 'pending');
    const photo = row?.photo;

    const markDone = async (withPhoto) => {
      let pic = photo;
      if (withPhoto) { pic = await capturePhoto(); if (!pic) return; }
      setDelivery(c.id, today, 'delivered', pic);
      notify(c.id, 'delivery', 'Delivery done', fmtQty(c.dailyMl) + ' delivered today.');
      viewDeliveryBoy();
    };
    const markSkip = () => {
      setDelivery(c.id, today, 'skipped');
      notify(c.id, 'delivery', 'Delivery skipped', 'Today\'s delivery was skipped.');
      viewDeliveryBoy();
    };

    const actions = paused
      ? el('span', { class: 'badge muted' }, t('paused'))
      : el('div', { class: 'row gap-sm' }, [
          photo ? el('img', { class: 'photo-thumb', src: photo, onclick: () => viewPhoto(photo) }) : null,
          el('button', { class: 'btn-camera', 'aria-label': t('add_photo'),
            onclick: () => markDone(true),
            html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
          }),
          el('button', { class: 'btn btn-sm btn-ghost', onclick: markSkip }, t('skip')),
          el('button', { class: 'btn btn-sm ' + (status === 'delivered' ? 'btn-primary' : 'btn-ghost'), onclick: () => markDone(false) }, t('done'))
        ]);

    list.appendChild(el('div', { class: 'list-item' }, [
      avatarFor(c),
      el('div', { class: 'li-body' }, [
        el('div', { class: 'li-title' }, c.name),
        c.address
          ? el('a', {
              class: 'li-sub', href: 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(c.address),
              target: '_blank', rel: 'noopener', style: 'color:var(--primary)'
            }, '📍 ' + fmtQty(c.dailyMl) + ' · ' + c.address.slice(0, 26))
          : el('div', { class: 'li-sub' }, fmtQty(c.dailyMl) + ' · +91 ' + c.mobile)
      ]),
      actions
    ]));
  });
  page.appendChild(list);

  // Quick call/whatsapp row at bottom (one helper for the assigned area)
  $view.appendChild(page);
}

/* ─── Customer dashboard ───────────────────────────────────── */
function viewCustomer() {
  const tabs = [
    { key: 'home',     label: t('today'),    icon: 'home' },
    { key: 'schedule', label: t('schedule'), icon: 'truck' },
    { key: 'bill',     label: t('bill'),     icon: 'bill' },
    { key: 'extras',   label: t('extras'),   icon: 'bag' }
  ];
  buildTabbar(tabs, App.customerTab, (k) => { App.customerTab = k; viewCustomer(); });
  // WhatsApp FAB to dairy owner
  $waBtn.href = 'https://wa.me/' + Store.data.settings.ownerWhatsApp + '?text=' + encodeURIComponent('Hi, I have a question about my milk delivery.');
  $waBtn.hidden = false;
  clear($view);

  switch (App.customerTab) {
    case 'home':     customerHome(); break;
    case 'schedule': customerSchedule(); break;
    case 'bill':     customerBill(); break;
    case 'extras':   customerExtras(); break;
  }
}

function customerHome() {
  $view.appendChild(topbar({ title: 'Hi, ' + App.user.name.split(' ')[0], subtitle: App.user.plan, bell: true, logout: true }));
  const page = el('div', { class: 'page' });
  const today = todayISO();
  const ts = todayStatus(App.user.id);
  const tone = ts.status === 'delivered' ? 'success' : ts.status === 'skipped' ? 'danger' : ts.status === 'paused' ? 'warn' : 'info';
  const emoji = ts.status === 'delivered' ? '✅' : ts.status === 'skipped' ? '✗' : ts.status === 'paused' ? '⏸' : '⏳';

  page.appendChild(el('div', { class: 'hero-stat' }, [
    el('div', { class: 'hero-stat-label' }, 'Today, ' + prettyDate(today)),
    el('div', { class: 'hero-stat-value' }, emoji + '  ' + ts.label),
    el('div', { class: 'hero-stat-foot' },
      ts.status === 'delivered' ? fmtQty(App.user.dailyMl) + ' delivered'
      : ts.status === 'paused' ? 'Resumes after pause window'
      : ts.status === 'skipped' ? 'No delivery today'
      : 'Pending delivery — ' + fmtQty(App.user.dailyMl))
  ]));

  // Quick controls
  page.appendChild(el('div', { class: 'quick-grid' }, [
    el('button', { class: 'quick-tile', onclick: () => { App.customerTab = 'schedule'; viewCustomer(); } }, [
      el('span', { class: 'icon', html: ICON.pause }),
      el('span', {}, 'Pause days')
    ]),
    el('button', { class: 'quick-tile', onclick: () => { App.customerTab = 'extras'; viewCustomer(); } }, [
      el('span', { class: 'icon', html: ICON.bag }),
      el('span', {}, 'Order extras')
    ]),
    el('button', { class: 'quick-tile', onclick: () => { App.customerTab = 'bill'; viewCustomer(); } }, [
      el('span', { class: 'icon', html: ICON.bill }),
      el('span', {}, 'View bill')
    ])
  ]));

  // Recent deliveries
  page.appendChild(el('div', { class: 'section-head' }, [el('h2', {}, 'Last 7 days')]));
  const card = el('div', { class: 'card' });
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const paused = isPaused(App.user.id, iso);
    const row = getDelivery(App.user.id, iso);
    const cls = paused ? 'badge muted' : row?.status === 'delivered' ? 'badge success' : row?.status === 'skipped' ? 'badge danger' : 'badge muted';
    const txt = paused ? t('paused') : row?.status === 'delivered' ? t('delivered') : row?.status === 'skipped' ? t('skipped') : '—';
    card.appendChild(el('div', { class: 'delivery-row' }, [
      el('span', { class: 'delivery-date' }, prettyDate(iso)),
      el('span', { style: 'flex:1' }, fmtQty(App.user.dailyMl)),
      row?.photo ? el('img', { class: 'photo-thumb', src: row.photo, onclick: () => viewPhoto(row.photo) }) : null,
      el('span', { class: cls }, txt)
    ]));
  }
  page.appendChild(card);
  $view.appendChild(page);
}

function customerSchedule() {
  $view.appendChild(topbar({ title: 'Schedule', subtitle: 'Pause / resume your delivery', bell: true }));
  const page = el('div', { class: 'page' });

  // Calendar of current month
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days = last.getDate();
  const startDay = first.getDay(); // 0 = Sun
  const customerId = App.user.id;
  const todayStr = todayISO();

  page.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'card-row', style: 'margin-bottom:8px' }, [
      el('div', { style: 'font-weight:700' }, first.toLocaleString('en-IN', { month: 'long', year: 'numeric' })),
      el('span', { class: 'badge info' }, App.user.plan)
    ]),
    (() => {
      const cal = el('div', { class: 'calendar' });
      ['S','M','T','W','T','F','S'].forEach(d => cal.appendChild(el('div', { class: 'cal-head' }, d)));
      for (let i = 0; i < startDay; i++) cal.appendChild(el('div', { class: 'cal-cell empty' }));
      for (let day = 1; day <= days; day++) {
        const iso = new Date(year, month, day).toISOString().slice(0, 10);
        const isFuture = iso > todayStr;
        const paused = isPaused(customerId, iso);
        const row = getDelivery(customerId, iso);
        let cls = 'cal-cell';
        if (iso === todayStr) cls += ' today';
        if (isFuture) cls += ' future';
        if (paused) cls += ' paused';
        else if (row?.status === 'delivered') cls += ' delivered';
        else if (row?.status === 'skipped') cls += ' skipped';
        cal.appendChild(el('button', {
          class: cls,
          onclick: () => {
            if (!isFuture && !paused) return toast('Past or today — only owner can change');
            togglePause(customerId, iso);
          }
        }, [
          el('span', {}, String(day)),
          el('span', { class: 'cal-dot' })
        ]));
      }
      return cal;
    })(),
    el('div', { class: 'cal-legend' }, [
      el('span', {}, [el('i', { style: 'background:var(--success)' }), ' Delivered']),
      el('span', {}, [el('i', { style: 'background:var(--warning)' }), ' Paused']),
      el('span', {}, [el('i', { style: 'background:var(--danger)' }), ' Skipped'])
    ])
  ]));

  // Pause range buttons
  page.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [el('h2', {}, 'Quick pause')]));
  page.appendChild(el('div', { class: 'row gap-sm wrap' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => quickPause(1) }, 'Tomorrow'),
    el('button', { class: 'btn btn-ghost', onclick: () => quickPause(3) }, 'Next 3 days'),
    el('button', { class: 'btn btn-ghost', onclick: () => quickPause(7) }, 'Next 7 days')
  ]));

  // Active pauses
  const activePauses = Store.data.pauses.filter(p =>
    p.customerId === customerId && p.to >= todayStr
  );
  if (activePauses.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:18px' }, [el('h2', {}, 'Upcoming pauses')]));
    const list = el('div', { class: 'list' });
    activePauses.forEach(p => {
      list.appendChild(el('div', { class: 'list-item' }, [
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, prettyDate(p.from) + ' – ' + prettyDate(p.to)),
          el('div', { class: 'li-sub' }, 'No delivery during this period')
        ]),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
          const removedId = p.id;
          Store.data.pauses = Store.data.pauses.filter(x => x.id !== removedId);
          Store.save();
          await Store.removeRemote('pauses', removedId);
          toast('Pause cancelled'); customerSchedule();
        } }, 'Resume')
      ]));
    });
    page.appendChild(list);
  }

  $view.appendChild(page);
}

function togglePause(customerId, iso) {
  const existing = Store.data.pauses.find(p => p.customerId === customerId && iso >= p.from && iso <= p.to);
  if (existing) {
    const removedId = existing.id;
    Store.data.pauses = Store.data.pauses.filter(x => x.id !== removedId);
    Store.save();
    Store.removeRemote('pauses', removedId);
    toast('Pause removed for ' + prettyDate(iso));
  } else {
    Store.data.pauses.push({ id: uid(), customerId, from: iso, to: iso });
    Store.save();
    toast('Paused for ' + prettyDate(iso));
  }
  customerSchedule();
}

function quickPause(days) {
  const from = new Date(); from.setDate(from.getDate() + 1);
  const to = new Date(); to.setDate(to.getDate() + days);
  Store.data.pauses.push({
    id: uid(), customerId: App.user.id,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  });
  Store.save();
  notify(App.user.id, 'pause', 'Delivery paused', 'Paused from ' + prettyDate(from.toISOString().slice(0,10)) + ' to ' + prettyDate(to.toISOString().slice(0,10)));
  toast('Paused for ' + days + ' day' + (days > 1 ? 's' : ''), 'success');
  customerSchedule();
}

function customerBill() {
  $view.appendChild(topbar({ title: 'My Bill', subtitle: prettyMonth(monthKey()), bell: true }));
  const page = el('div', { class: 'page' });
  const month = monthKey();
  const b = customerMonthBill(App.user.id, month);
  const products = Store.data.settings.products;

  page.appendChild(el('div', { class: 'hero-stat' }, [
    el('div', { class: 'hero-stat-label' }, b.due > 0 ? 'Amount due' : 'Total'),
    el('div', { class: 'hero-stat-value' }, fmtMoney(b.due > 0 ? b.due : b.total)),
    el('div', { class: 'hero-stat-foot' }, b.deliveries + ' deliveries · ' + fmtQty(b.totalMl))
  ]));

  page.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'bill-rows' }, [
      el('div', { class: 'bill-row' }, [el('span', {}, 'Water delivered'), el('span', { class: 'text-mono' }, fmtQty(b.totalMl))]),
      el('div', { class: 'bill-row' }, [el('span', {}, 'Water amount @ ' + fmtMoney(Store.data.settings.pricePerLitre) + '/L'), el('span', { class: 'text-mono' }, fmtMoney(b.milkAmt))]),
      ...b.extras.map(o => el('div', { class: 'bill-row' }, [
        el('span', {}, products[o.productKey].name + ' × ' + o.qty),
        el('span', { class: 'text-mono' }, fmtMoney(products[o.productKey].price * o.qty))
      ])),
      b.paid > 0 ? el('div', { class: 'bill-row' }, [
        el('span', {}, 'Paid'),
        el('span', { class: 'text-mono', style: 'color:var(--success)' }, '− ' + fmtMoney(b.paid))
      ]) : null,
      el('div', { class: 'bill-row total' }, [
        el('span', {}, b.due > 0 ? 'Due' : 'Total'),
        el('span', { class: 'text-mono' }, fmtMoney(b.due > 0 ? b.due : b.total))
      ])
    ])
  ]));

  if (b.due > 0) {
    page.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:14px',
      onclick: () => payViaUPI(b.due)
    }, 'Pay ' + fmtMoney(b.due) + ' via UPI'));
  } else if (b.total > 0) {
    page.appendChild(el('div', { class: 'card text-center', style: 'margin-top:12px;color:var(--success);font-weight:600' }, '✓ All paid for this month'));
  }
  $view.appendChild(page);
}

function payViaUPI(amount) {
  const link = upiDeepLink(amount, 'DailyWater ' + monthKey());
  const img = makeQRImage(link);
  const wrap = el('div', {});
  wrap.appendChild(el('p', { class: 'text-muted text-center', style: 'margin-bottom:8px' },
    'Tap "Open UPI app" or scan the QR with any UPI app.'));
  // Open UPI app deep link
  wrap.appendChild(el('a', {
    class: 'btn btn-primary btn-block', href: link, style: 'margin-bottom:10px'
  }, 'Open UPI app to pay ' + fmtMoney(amount)));
  // QR
  const box = el('div', { class: 'qr-box' });
  if (img) box.appendChild(img);
  box.appendChild(el('div', { class: 'qr-amount' }, fmtMoney(amount)));
  box.appendChild(el('div', { class: 'qr-id' }, Store.data.settings.upiId));
  wrap.appendChild(box);
  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block',
    onclick: () => {
      Store.data.payments.push({
        id: uid(), customerId: App.user.id, month: monthKey(),
        amount, date: new Date().toISOString(), method: 'upi'
      });
      Store.save();
      notify(App.user.id, 'payment', 'Payment confirmed', fmtMoney(amount) + ' will reflect after owner verification.');
      // Also notify the owner
      const owner = Store.data.users.find(u => u.role === 'owner');
      if (owner) notify(owner.id, 'payment', 'Payment received', App.user.name + ' paid ' + fmtMoney(amount));
      toast('Payment recorded', 'success');
      closeModal(); viewCustomer();
    }
  }, 'I have paid'));
  openModal('Pay via UPI', wrap);
}

function customerExtras() {
  $view.appendChild(topbar({ title: 'Order extras', subtitle: 'Cans, bottles & more', bell: true }));
  const page = el('div', { class: 'page' });
  const products = Store.data.settings.products;
  const activeEntries = Object.entries(products).filter(([, p]) => p.active !== false);

  if (activeEntries.length === 0) {
    page.appendChild(emptyState('🛒', 'No extras available', 'Check back later — owner is updating the menu.'));
  } else {
    page.appendChild(el('div', { class: 'prod-grid' },
      activeEntries.map(([key, p]) => {
        const stock = Number(p.stock) || 0;
        const ratings = (Store.data.productRatings || []).filter(r => r.productKey === key);
        const avg = ratings.length ? (ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) : 0;
        const stockBadge = stock <= 0
          ? el('div', { class: 'prod-stock out' }, 'Out of stock')
          : (stock <= 5 ? el('div', { class: 'prod-stock low' }, 'Only ' + stock + ' left') : el('div', { class: 'prod-stock' }, stock + ' in stock'));
        const ratingRow = ratings.length
          ? el('div', { class: 'prod-rating' }, '★ ' + avg.toFixed(1) + ' (' + ratings.length + ')')
          : el('div', { class: 'prod-rating muted' }, 'No ratings yet');
        return el('div', { class: 'prod-card' + (stock <= 0 ? ' is-disabled' : '') }, [
          el('div', { class: 'prod-emoji' }, p.emoji || '💧'),
          el('div', { class: 'prod-name' }, p.name),
          el('div', { class: 'prod-price' }, fmtMoney(p.price)),
          ratingRow,
          stockBadge,
          el('button', {
            class: 'btn btn-primary btn-sm',
            disabled: stock <= 0 ? true : null,
            onclick: () => orderExtra(key)
          }, stock <= 0 ? 'Out of stock' : 'Order')
        ]);
      })
    ));
  }

  // Recent orders
  const orders = Store.data.extraOrders.filter(o => o.customerId === App.user.id).sort((a,b)=>b.date.localeCompare(a.date)).slice(0, 5);
  if (orders.length) {
    page.appendChild(el('div', { class: 'section-head', style: 'margin-top:20px' }, [el('h2', {}, 'Recent orders')]));
    const list = el('div', { class: 'list' });

    // Cache month bills (1 lookup per unique month)
    const monthBills = {};
    const billFor = (mo) => monthBills[mo] || (monthBills[mo] = customerMonthBill(App.user.id, mo));

    orders.forEach(o => {
      const p = products[o.productKey];
      const editable = o.status === 'pending' || o.status === 'confirmed';
      const orderMonth = o.date.slice(0, 7);
      const mBill = billFor(orderMonth);

      // Pick badge based on order + bill state
      let badgeText, badgeClass;
      if (o.status === 'cancelled') {
        badgeText = 'Cancelled'; badgeClass = 'danger';
      } else if (o.status === 'delivered') {
        if (mBill.due === 0 && mBill.paid > 0) { badgeText = '✓ Settled'; badgeClass = 'success'; }
        else if (mBill.due > 0) { badgeText = 'Delivered · ₹' + Math.round(mBill.due) + ' due'; badgeClass = 'warn'; }
        else { badgeText = 'Delivered'; badgeClass = 'success'; }
      } else if (o.status === 'confirmed') {
        badgeText = 'Confirmed'; badgeClass = 'info';
      } else {
        badgeText = 'Pending'; badgeClass = 'warn';
      }

      // Rating button — only for delivered orders that aren't yet rated
      const myRating = (Store.data.productRatings || []).find(r => r.orderId === o.id && r.customerId === App.user.id);
      const showRate = o.status === 'delivered' && p;
      const rateBtn = showRate ? el('button', {
        class: 'btn btn-sm ' + (myRating ? 'btn-ghost' : 'btn-primary'),
        style: 'margin-left:8px',
        onclick: (ev) => { ev.stopPropagation(); openRatingModal(o.id, o.productKey, myRating); }
      }, myRating ? '★ ' + myRating.rating : 'Rate') : null;

      list.appendChild(el('div', {
        class: 'list-item' + (editable ? ' is-clickable' : ''),
        onclick: editable ? () => editExtraOrder(o.id) : null
      }, [
        el('div', { class: 'li-avatar' }, p?.emoji || '💧'),
        el('div', { class: 'li-body' }, [
          el('div', { class: 'li-title' }, (p?.name || 'Removed item') + ' × ' + o.qty),
          el('div', { class: 'li-sub' }, prettyDate(o.date.slice(0, 10)) + (editable ? ' · tap to edit' : (myRating ? ' · "' + (myRating.review || '').slice(0, 30) + (myRating.review && myRating.review.length > 30 ? '…' : '') + '"' : '')))
        ]),
        el('div', { class: 'li-aside', style: 'display:flex;align-items:center' }, [
          el('span', { class: 'badge ' + badgeClass }, badgeText),
          rateBtn
        ])
      ]));
    });
    page.appendChild(list);
  }

  $view.appendChild(page);
}

function orderExtra(productKey) {
  const p = Store.data.settings.products[productKey];
  const stock = Number(p.stock) || 0;
  if (stock <= 0) { toast('Out of stock', 'error'); return; }
  const wrap = el('div', {});
  let qty = 1;
  const qtyDisplay = el('div', { class: 'text-center text-mono', style: 'font-size:32px;font-weight:800;margin:14px 0' }, '1');
  const qtyAmt = el('div', { class: 'text-muted text-center' }, 'Total: ' + fmtMoney(p.price));
  const stockLine = el('div', { class: 'text-muted text-center', style: 'font-size:13px' }, stock + ' in stock');
  const update = () => {
    qtyDisplay.textContent = qty;
    qtyAmt.textContent = 'Total: ' + fmtMoney(p.price * qty);
  };
  wrap.appendChild(el('div', { class: 'text-center', style: 'font-size:48px' }, p.emoji));
  wrap.appendChild(el('div', { class: 'text-center', style: 'font-weight:700;margin-top:6px' }, p.name));
  wrap.appendChild(el('div', { class: 'text-center text-muted' }, fmtMoney(p.price) + ' each'));
  wrap.appendChild(stockLine);
  wrap.appendChild(qtyDisplay);
  wrap.appendChild(el('div', { class: 'row gap-sm', style: 'justify-content:center;margin-bottom:6px' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => { qty = Math.max(1, qty - 1); update(); } }, '−'),
    el('button', { class: 'btn btn-ghost', onclick: () => { qty = Math.min(20, qty + 1); update(); } }, '+')
  ]));
  wrap.appendChild(qtyAmt);
  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:14px',
    onclick: () => {
      // Re-read stock at click time (might have changed via realtime)
      const currentStock = Number(Store.data.settings.products[productKey]?.stock) || 0;
      const owner = Store.data.users.find(u => u.role === 'owner');
      if (qty > currentStock) {
        toast('Only ' + currentStock + ' available — order not placed', 'error');
        if (owner) {
          notify(owner.id, 'order', 'Order blocked — low stock',
            App.user.name + ' tried to order ' + p.name + ' × ' + qty + ' but stock is only ' + currentStock + '.');
        }
        notify(App.user.id, 'order', 'Order not placed',
          'Only ' + currentStock + ' ' + p.name + ' available. Try a smaller quantity or check back later.');
        closeModal();
        return;
      }
      // Reserve: deduct stock now to prevent double-booking
      Store.data.settings.products[productKey].stock = currentStock - qty;
      Store.data.extraOrders.push({
        id: uid(), customerId: App.user.id, productKey, qty,
        date: new Date().toISOString(), status: 'pending'
      });
      Store.save();
      notify(App.user.id, 'order', 'Order placed', p.name + ' × ' + qty + ' — added to next delivery.');
      if (owner) notify(owner.id, 'order', 'New extras order', App.user.name + ': ' + p.name + ' × ' + qty);
      toast('Order placed', 'success');
      closeModal(); viewCustomer();
    }
  }, 'Place order'));
  openModal('Order ' + p.name, wrap);
}

function editExtraOrder(orderId) {
  const o = Store.data.extraOrders.find(x => x.id === orderId);
  if (!o) return;
  const p = Store.data.settings.products[o.productKey];
  const owner = Store.data.users.find(u => u.role === 'owner');
  const wrap = el('div', {});
  let qty = o.qty;
  const qtyDisplay = el('div', { class: 'text-center text-mono', style: 'font-size:32px;font-weight:800;margin:14px 0' }, String(qty));
  const qtyAmt = el('div', { class: 'text-muted text-center' }, 'Total: ' + fmtMoney((p?.price || 0) * qty));
  const update = () => {
    qtyDisplay.textContent = qty;
    qtyAmt.textContent = 'Total: ' + fmtMoney((p?.price || 0) * qty);
  };

  wrap.appendChild(el('div', { class: 'text-center', style: 'font-size:48px' }, p?.emoji || '💧'));
  wrap.appendChild(el('div', { class: 'text-center', style: 'font-weight:700;margin-top:6px' }, p?.name || 'Removed item'));
  wrap.appendChild(el('div', { class: 'text-center text-muted' }, fmtMoney(p?.price || 0) + ' each · ' + prettyDate(o.date.slice(0,10))));
  wrap.appendChild(el('div', { class: 'text-center', style: 'margin:8px 0' }, [
    el('span', { class: 'badge ' + (o.status === 'confirmed' ? 'info' : 'warn') }, 'Status: ' + o.status)
  ]));

  // Qty editor — only when pending. Increases bounded by current stock + already-reserved qty.
  if (o.status === 'pending' && p) {
    const stockAvail = Number(p.stock) || 0;
    const maxQty = Math.min(20, stockAvail + o.qty); // can return reserved qty + take new stock
    wrap.appendChild(el('div', { class: 'text-muted text-center', style: 'font-size:13px' }, stockAvail + ' more in stock'));
    wrap.appendChild(qtyDisplay);
    wrap.appendChild(el('div', { class: 'row gap-sm', style: 'justify-content:center;margin-bottom:6px' }, [
      el('button', { class: 'btn btn-ghost', onclick: () => { qty = Math.max(1, qty - 1); update(); } }, '−'),
      el('button', { class: 'btn btn-ghost', onclick: () => {
        if (qty + 1 > maxQty) { toast('Only ' + maxQty + ' available (incl. your reserved ' + o.qty + ')', 'error'); return; }
        qty = qty + 1; update();
      } }, '+')
    ]));
    wrap.appendChild(qtyAmt);
    wrap.appendChild(el('button', {
      class: 'btn btn-primary btn-block', style: 'margin-top:14px',
      onclick: () => {
        if (qty === o.qty) { closeModal(); return; }
        const oldQty = o.qty;
        const delta = qty - oldQty;
        const liveStock = Number(Store.data.settings.products[o.productKey]?.stock) || 0;
        if (delta > liveStock) {
          toast('Stock changed — only ' + liveStock + ' more available', 'error');
          return;
        }
        Store.data.settings.products[o.productKey].stock = liveStock - delta;
        o.qty = qty;
        Store.save();
        if (owner) notify(owner.id, 'order', 'Order edited', App.user.name + ': ' + p.name + ' qty ' + oldQty + ' → ' + qty);
        toast('Order updated', 'success');
        closeModal(); viewCustomer();
      }
    }, 'Save changes'));
  } else if (o.status === 'confirmed') {
    wrap.appendChild(el('div', { class: 'card text-center text-muted', style: 'margin:10px 0' },
      'Owner has confirmed this order — qty can\'t be changed. You can still cancel.'));
  }

  // Cancel button — pending or confirmed (refunds reserved stock)
  wrap.appendChild(el('button', {
    class: 'btn btn-danger btn-block', style: 'margin-top:8px',
    onclick: async () => {
      if (!await confirmDialog('Cancel this order?', (p?.name || 'This order') + ' × ' + o.qty + ' will be cancelled.', 'Cancel order')) return;
      // Refund stock if it was reserved (pending or confirmed)
      if ((o.status === 'pending' || o.status === 'confirmed') && p) {
        Store.data.settings.products[o.productKey].stock = (Number(p.stock) || 0) + o.qty;
      }
      o.status = 'cancelled';
      Store.save();
      if (owner) notify(owner.id, 'order', 'Order cancelled', App.user.name + ' cancelled ' + (p?.name || 'an order') + ' × ' + o.qty);
      toast('Order cancelled');
      closeModal(); viewCustomer();
    }
  }, 'Cancel order'));

  openModal('Manage order', wrap);
}

/* ─── Product rating modal ────────────────────────────────── */
function openRatingModal(orderId, productKey, existing) {
  const p = Store.data.settings.products[productKey];
  if (!p) { toast('Product no longer available', 'error'); return; }
  const wrap = el('div', {});
  let rating = existing ? existing.rating : 0;
  let review = existing ? (existing.review || '') : '';

  wrap.appendChild(el('div', { class: 'text-center', style: 'font-size:48px' }, p.emoji || '💧'));
  wrap.appendChild(el('div', { class: 'text-center', style: 'font-weight:700;margin-top:6px' }, p.name));
  wrap.appendChild(el('div', { class: 'text-center text-muted', style: 'font-size:13px;margin-bottom:14px' },
    'How was this product?'));

  const starsRow = el('div', { class: 'rating-row' });
  const renderStars = () => {
    starsRow.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      starsRow.appendChild(el('button', {
        type: 'button',
        class: 'star-btn' + (i <= rating ? ' filled' : ''),
        'aria-label': i + ' star' + (i > 1 ? 's' : ''),
        onclick: () => { rating = i; renderStars(); }
      }, '★'));
    }
  };
  renderStars();
  wrap.appendChild(starsRow);

  const reviewInput = el('textarea', {
    class: 'input', rows: 3,
    placeholder: 'Optional — what did you think? (e.g., "Fresh and creamy")',
    style: 'width:100%;resize:vertical;margin-top:12px',
    oninput: (e) => review = e.target.value
  });
  reviewInput.value = review;
  wrap.appendChild(reviewInput);

  wrap.appendChild(el('button', {
    class: 'btn btn-primary btn-block', style: 'margin-top:14px',
    onclick: async () => {
      if (!rating || rating < 1) { toast('Pick 1-5 stars', 'error'); return; }
      const trimmedReview = review.trim();
      if (existing) {
        existing.rating = rating;
        existing.review = trimmedReview;
        existing.date = new Date().toISOString();
      } else {
        Store.data.productRatings.push({
          id: uid(), customerId: App.user.id, productKey, orderId,
          rating, review: trimmedReview, date: new Date().toISOString()
        });
      }
      Store.save();
      const owner = Store.data.users.find(u => u.role === 'owner');
      if (owner) notify(owner.id, 'order',
        existing ? 'Rating updated' : 'New product rating',
        App.user.name + ' rated ' + p.name + ' ' + rating + '★' + (trimmedReview ? ': "' + trimmedReview.slice(0, 50) + '"' : ''));
      toast('Thanks for rating!', 'success');
      closeModal();
      viewCustomer();
    }
  }, existing ? 'Update rating' : 'Submit rating'));

  if (existing) {
    wrap.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px;color:var(--danger)',
      onclick: async () => {
        if (!await confirmDialog('Remove rating?', 'Your ' + existing.rating + '★ rating will be deleted.', 'Remove')) return;
        const removedId = existing.id;
        Store.data.productRatings = Store.data.productRatings.filter(r => r.id !== removedId);
        Store.save();
        await Store.removeRemote('product_ratings', removedId);
        toast('Rating removed');
        closeModal();
        viewCustomer();
      }
    }, 'Remove rating'));
  }

  openModal(existing ? 'Edit your rating' : 'Rate this product', wrap);
}

/* ─── Notifications view ───────────────────────────────────── */
function goNotifications() {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  const back = () => { App.notifSelection = null; navigate(App.user.role); };
  $view.appendChild(topbar({ title: 'Notifications', back }));
  const page = el('div', { class: 'page' });
  const items = getNotifs(App.user.id);

  // Selection state — survives across re-renders within this view
  if (!App.notifSelection) App.notifSelection = { mode: false, ids: new Set() };
  const sel = App.notifSelection;
  // Drop ids that no longer exist
  sel.ids = new Set([...sel.ids].filter(id => items.some(n => n.id === id)));

  if (items.length === 0) {
    page.appendChild(emptyState('🔔', 'All clear', 'No notifications yet.'));
    $view.appendChild(page);
    return;
  }

  // Toolbar — toggles selection mode + Select all + Delete selected
  const toolbar = el('div', { class: 'row gap-sm', style: 'margin-bottom:10px;flex-wrap:wrap' });
  if (!sel.mode) {
    toolbar.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: () => { sel.mode = true; sel.ids = new Set(); goNotifications(); }
    }, '☑ Select'));
  } else {
    const allSelected = sel.ids.size === items.length;
    toolbar.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: () => {
        if (allSelected) sel.ids = new Set();
        else sel.ids = new Set(items.map(n => n.id));
        goNotifications();
      }
    }, allSelected ? 'Unselect all' : 'Select all (' + items.length + ')'));
    toolbar.appendChild(el('button', {
      class: 'btn btn-sm btn-danger',
      disabled: sel.ids.size === 0 ? true : null,
      onclick: async () => {
        if (sel.ids.size === 0) return;
        if (!await confirmDialog('Delete selected?',
          'Permanently remove ' + sel.ids.size + ' notification' + (sel.ids.size === 1 ? '' : 's') + '.',
          'Delete')) return;
        const idsArr = [...sel.ids];
        Store.data.notifications = Store.data.notifications.filter(n => !sel.ids.has(n.id));
        Store.save();
        await Store.removeRemote('notifications', idsArr);
        toast('Deleted ' + idsArr.length);
        sel.mode = false; sel.ids = new Set();
        goNotifications();
      }
    }, '🗑 Delete (' + sel.ids.size + ')'));
    toolbar.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: () => { sel.mode = false; sel.ids = new Set(); goNotifications(); }
    }, 'Cancel'));
  }
  page.appendChild(toolbar);

  const list = el('div', { class: 'list' });
  items.forEach(n => {
    const isSelected = sel.ids.has(n.id);
    const row = el('div', {
      class: 'notif-item' + (n.read ? '' : ' unread') + (sel.mode ? ' is-selectable' : '') + (isSelected ? ' is-selected' : ''),
      onclick: sel.mode ? () => {
        if (isSelected) sel.ids.delete(n.id);
        else sel.ids.add(n.id);
        goNotifications();
      } : () => {
        if (!n.read) { n.read = true; Store.save(); }
        // Admin tapping a "New owner signup" notif → open that pending owner's detail modal
        if (App.user && App.user.role === 'admin' && n.type === 'order' && /signup/i.test(n.title || '')) {
          const m = (n.body || '').match(/(\d{10})/);
          const pending = m && Store.data.users.find(u =>
            u.mobile === m[1] && u.role === 'owner' && u.status === 'pending'
          );
          if (pending) { adminOwnerDetail(pending.id); return; }
          navigate('admin'); return;
        }
      }
    }, [
      sel.mode ? el('input', {
        type: 'checkbox', class: 'notif-check', checked: isSelected,
        onclick: (ev) => ev.stopPropagation(),
        onchange: (ev) => {
          if (ev.target.checked) sel.ids.add(n.id);
          else sel.ids.delete(n.id);
          goNotifications();
        }
      }) : null,
      el('div', { class: 'notif-icon' }, n.type === 'payment' ? '💳' : n.type === 'order' ? '🛒' : n.type === 'pause' ? '⏸' : n.type === 'delivery' ? '💧' : '🔔'),
      el('div', { class: 'notif-body' }, [
        el('div', { class: 'notif-title' }, n.title),
        el('div', { class: 'notif-sub' }, n.body),
        el('div', { class: 'notif-time' }, new Date(n.date).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }))
      ])
    ]);
    list.appendChild(row);
  });
  page.appendChild(list);

  if (!sel.mode) {
    page.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:14px',
      onclick: () => {
        getNotifs(App.user.id).forEach(n => n.read = true);
        Store.save();
        toast('Marked as read');
        goNotifications();
      }
    }, 'Mark all as read'));
    page.appendChild(el('button', {
      class: 'btn btn-ghost btn-block', style: 'margin-top:8px;color:var(--danger)',
      onclick: async () => {
        const mine = getNotifs(App.user.id);
        if (mine.length === 0) return;
        if (!await confirmDialog('Delete all notifications?',
          'Permanently remove all ' + mine.length + ' notifications. This cannot be undone.',
          'Delete all')) return;
        const ids = mine.map(n => n.id);
        Store.data.notifications = Store.data.notifications.filter(n => n.userId !== App.user.id);
        Store.save();
        await Store.removeRemote('notifications', ids);
        toast('All notifications deleted');
        goNotifications();
      }
    }, '🗑 Delete all notifications'));
  }

  $view.appendChild(page);
  // Mark all as read on view (only when not in selection mode)
  if (!sel.mode) setTimeout(() => {
    let changed = false;
    getNotifs(App.user.id).forEach(n => { if (!n.read) { n.read = true; changed = true; } });
    if (changed) Store.save();
  }, 1500);
}

/* ─── Router ───────────────────────────────────────────────── */
function navigate(route) {
  App.route = route;
  if (route === 'login') {
    setSession(null);
    viewLogin();
  } else if (route === 'admin') {
    if (!App.user || App.user.role !== 'admin') return navigate('login');
    viewAdmin();
  } else if (route === 'owner') {
    if (!App.user || App.user.role !== 'owner') return navigate('login');
    if (App.user.status && App.user.status !== 'approved') return navigate('login');
    // Subscription gate — past grace, owner can only see the renewal screen
    if (ownerSubscriptionState(App.user) === 'expired') return viewOwnerLocked();
    viewOwner();
  } else if (route === 'owner_locked') {
    if (!App.user || App.user.role !== 'owner') return navigate('login');
    viewOwnerLocked();
  } else if (route === 'customer') {
    if (!App.user || App.user.role !== 'customer') return navigate('login');
    // Customer's dairy past grace → kick them out
    const dairy = activeOwnerForSession();
    if (dairy && ownerSubscriptionState(dairy) === 'expired') {
      toast('Service expired — contact your supplier', 'error');
      return navigate('login');
    }
    viewCustomer();
  } else if (route === 'delivery_boy') {
    if (!App.user || App.user.role !== 'delivery_boy') return navigate('login');
    const dairy = activeOwnerForSession();
    if (dairy && ownerSubscriptionState(dairy) === 'expired') {
      toast('Service expired — contact your supplier', 'error');
      return navigate('login');
    }
    viewDeliveryBoy();
  }
  window.scrollTo(0, 0);
  document.documentElement.lang = (Store.data && Store.data.language) || 'en';
}

// Locked owner home — shown when subscription is past grace. Only the renew action works.
function viewOwnerLocked() {
  document.body.classList.add('no-tabs');
  $tabbar.hidden = true;
  $waBtn.hidden = true;
  clear($view);
  $view.appendChild(topbar({
    title: 'Subscription expired',
    subtitle: App.user.name,
    logout: true
  }));

  const exp = ownerExpiryInfo(App.user);
  const overdueDays = exp.daysLeft != null ? Math.abs(exp.daysLeft) : '?';

  const page = el('div', { class: 'page' });
  page.appendChild(el('div', { class: 'card sub-expired', style: 'padding:20px;text-align:center;border-radius:14px' }, [
    el('div', { style: 'font-size:60px' }, '⛔'),
    el('div', { style: 'font-weight:800;font-size:20px;margin-top:8px' }, 'Service has expired'),
    el('div', { style: 'font-size:13px;margin-top:6px;opacity:.9' },
      'Your subscription expired ' + overdueDays + ' day' + (overdueDays === 1 ? '' : 's') + ' ago. ' +
      'Your customers and delivery boys cannot use the app until you renew.'),
    el('div', { style: 'font-size:13px;margin-top:14px;opacity:.9' }, 'Pick a plan below to renew now.')
  ]));

  const plans = getPlans().filter(p => p.active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (plans.length === 0) {
    page.appendChild(el('div', { class: 'card text-muted', style: 'margin-top:12px' }, 'No plans available — please contact admin.'));
  } else {
    buildPlanPicker(page, plans);
  }

  page.appendChild(el('button', {
    class: 'btn btn-ghost btn-block', style: 'margin-top:18px',
    onclick: () => { setSession(null); navigate('login'); }
  }, 'Sign out'));
  page.appendChild(el('div', { class: 'text-muted', style: 'font-size:11px;text-align:center;margin-top:8px' },
    'After payment, admin will mark your account as paid and you can resume normal use.'));

  $view.appendChild(page);
}

/* ─── Boot ─────────────────────────────────────────────────── */
// Fast path: render from cache immediately
Store.loadFromCache();
applyTheme(Store.data?.theme || 'auto');
const session = restoreSession();
const joinParam = (() => { try { return new URLSearchParams(location.search).get('join'); } catch (e) { return null; } })();
if (joinParam && !session) {
  viewJoin(joinParam);
} else if (session) {
  App.user = session;
  navigate(session.role);
} else {
  navigate('login');
}
// Slow path: fetch fresh from Supabase, replace, re-render
Store.load().catch(e => console.warn('Store.load failed', e));

// Expose for debugging in console
window.MM = { Store, App, navigate, seed, reset: () => { Store.reset(); location.reload(); } };

})();
