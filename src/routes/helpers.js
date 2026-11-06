// Small helpers shared by the route files.

// Checkbox lists arrive as a string (one ticked) or an array (several ticked).
function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

// Redirect with a one-line message shown at the top of the next page.
function redirectWith(res, url, { msg, err } = {}) {
  const q = new URLSearchParams();
  if (msg) q.set('msg', msg);
  if (err) q.set('err', err);
  const qs = q.toString();
  res.redirect(qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url);
}

function flash(req) {
  return { msg: req.query.msg || null, err: req.query.err || null };
}

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = { toArray, redirectWith, flash, idParam };
