// ============================================================
// ISIC Meta Ads Proxy — Google Apps Script
// Deploy as Web App: Execute as Me, Access: Anyone
// ============================================================

const META_TOKEN = 'EAAaH095K8dQBRpZCQmSMMrDSZAZBSTXORu3oHdgiGVWm3GwVeVXf0b5ZCzp6kzvTIZAkpkn3yTIl8vzCB9mmwBaMxNiBGm3kx4OjFaZB8c1F7sAV9GZBvZB2gIoAl56QaefSS7OomcF3nMQ3NiJvz2mPao2IkXbWBGJIvZAaHNodvhzM0FyVdjfPI6ZAlNZAzDZC';
const AD_ACCOUNT = '1574694997262883';
const BASE_URL   = 'https://graph.facebook.com/v21.0';

// ------------------------------------------------------------
// GET handler
// ------------------------------------------------------------
function doGet(e) {
  const p      = e.parameter || {};
  const action = p.action || 'all';
  const preset = p.date_preset || 'last_90d';
  const limit  = parseInt(p.limit) || 92;

  try {
    let result;
    switch (action) {
      case 'summary':   result = getSummary(preset);               break;
      case 'campaigns': result = getCampaigns(preset);             break;
      case 'daily':     result = getDailyInsights(preset, limit);  break;
      case 'organic':   result = getOrganicInsights(preset);       break;
      case 'account':   result = getAccountInfo();                 break;
      case 'all':
        result = {
          summary:   getSummary(preset),
          campaigns: getCampaigns(preset),
          daily:     getDailyInsights(preset, limit)
        };
        break;
      default: result = { error: 'Unknown action: ' + action };
    }
    return buildResponse(result);
  } catch (err) {
    return buildResponse({ error: err.message });
  }
}

// ------------------------------------------------------------
// Account info (name, currency, timezone)
// ------------------------------------------------------------
function getAccountInfo() {
  const url = buildUrl('act_' + AD_ACCOUNT, {
    fields: 'name,currency,timezone_name'
  });
  return fetchMeta(url);
}

// ------------------------------------------------------------
// Summary — account-level totals
// ------------------------------------------------------------
function getSummary(preset) {
  const url = buildUrl('act_' + AD_ACCOUNT + '/insights', {
    fields:      'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,action_values',
    date_preset: preset
  });
  const data = fetchMeta(url);
  return data.data ? data.data[0] || {} : {};
}

// ------------------------------------------------------------
// Campaigns — with per-campaign insights
// ------------------------------------------------------------
function getCampaigns(preset) {
  const campUrl = buildUrl('act_' + AD_ACCOUNT + '/campaigns', {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget',
    limit:  50
  });
  const camps = fetchMeta(campUrl).data || [];
  return camps.map(function(c) {
    try {
      const insUrl = buildUrl(c.id + '/insights', {
        fields:      'spend,impressions,clicks,ctr,cpc,cpm,reach,actions,action_values',
        date_preset: preset
      });
      const ins = fetchMeta(insUrl).data;
      c.insights = (ins && ins.length) ? ins[0] : null;
    } catch (_) { c.insights = null; }
    return c;
  });
}

// ------------------------------------------------------------
// Daily breakdown — one row per day
// ------------------------------------------------------------
function getDailyInsights(preset, limit) {
  const url = buildUrl('act_' + AD_ACCOUNT + '/insights', {
    fields:         'date_start,spend,impressions,clicks,reach,ctr,cpc,cpm',
    date_preset:    preset,
    time_increment: 1,
    limit:          limit || 92
  });
  return fetchMeta(url).data || [];
}

// ------------------------------------------------------------
// Organic Facebook Page insights
// Requires: pages_read_engagement, read_insights on the token
// ------------------------------------------------------------
function getOrganicInsights(preset) {
  // Resolve the Page ID managed by this token
  const pageId = getLinkedPageId();
  if (!pageId) {
    return { available: false, reason: 'No Facebook Page found for this token' };
  }

  const dates  = presetToSinceUntil(preset);
  const metrics = [
    'page_impressions_organic_unique',
    'page_impressions_organic',
    'page_post_engagements',
    'page_fan_adds_unique',
    'page_fans'
  ].join(',');

  const url = buildUrl(pageId + '/insights', {
    metric: metrics,
    period: 'day',
    since:  dates.since,
    until:  dates.until
  });

  let json;
  try {
    json = fetchMeta(url);
  } catch (err) {
    return { available: false, reason: err.message };
  }

  const result = { available: true, pageId: pageId, metrics: {} };
  (json.data || []).forEach(function(m) {
    let total = 0;
    const daily = {};
    (m.values || []).forEach(function(v) {
      const key = v.end_time ? v.end_time.slice(0, 10) : '';
      const val = typeof v.value === 'number' ? v.value : 0;
      daily[key] = val;
      total += val;
    });
    const latest = m.values && m.values.length ? m.values[m.values.length - 1].value : 0;
    result.metrics[m.name] = { total: total, daily: daily, latest: latest };
  });

  // Attach Instagram basic reach if accessible
  try {
    const igData = getIgInsights(preset);
    if (igData) result.instagram = igData;
  } catch (_) { /* no-op */ }

  return result;
}

// ------------------------------------------------------------
// Instagram Business Account reach/engagement
// ------------------------------------------------------------
function getIgInsights(preset) {
  // Get IG user ID linked to the page
  const pages = fetchMeta(buildUrl('me/accounts', { fields: 'id,instagram_business_account' })).data || [];
  const page  = pages.find(function(p) { return p.instagram_business_account; });
  if (!page) return null;

  const igId  = page.instagram_business_account.id;
  const dates = presetToSinceUntil(preset);

  const url = buildUrl(igId + '/insights', {
    metric: 'reach,impressions,profile_views',
    period: 'day',
    since:  dates.since,
    until:  dates.until
  });

  const json = fetchMeta(url);
  const result = { igId: igId, metrics: {} };
  (json.data || []).forEach(function(m) {
    let total = 0;
    (m.values || []).forEach(function(v) { total += typeof v.value === 'number' ? v.value : 0; });
    result.metrics[m.name] = { total: total };
  });
  return result;
}

// ------------------------------------------------------------
// Helper: first Facebook Page this token can access
// ------------------------------------------------------------
function getLinkedPageId() {
  try {
    const json = fetchMeta(buildUrl('me/accounts', { fields: 'id,name', limit: 5 }));
    return (json.data && json.data.length) ? json.data[0].id : null;
  } catch (_) { return null; }
}

// ------------------------------------------------------------
// Helper: preset string → Unix timestamps
// ------------------------------------------------------------
function presetToSinceUntil(preset) {
  const now   = Math.floor(Date.now() / 1000);
  const daysMap = {
    last_7d: 7, last_30d: 30, last_90d: 90,
    last_6m: 180, this_month: new Date().getDate(), last_month: 62
  };
  const days  = daysMap[preset] || 90;
  return { since: now - days * 86400, until: now };
}

// ------------------------------------------------------------
// Core utilities
// ------------------------------------------------------------
function buildUrl(path, params) {
  params.access_token = META_TOKEN;
  const qs = Object.keys(params)
    .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  return BASE_URL + '/' + path + '?' + qs;
}

function fetchMeta(url) {
  const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText());
  if (json.error) throw new Error(json.error.message);
  return json;
}

function buildResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
