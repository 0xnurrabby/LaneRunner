// /api/fcprofile
// address -> { username, displayName, pfp, name }
// name will be: username.farcaster.eth  (fallback: null)

module.exports = async function handler(req, res) {
  try {
    const key = process.env.NEYNAR_API_KEY;
    const addr = String(req.query.addr || "").toLowerCase();

    if (!key || !addr || !addr.startsWith("0x") || addr.length !== 42) {
      return res.status(200).json({ ok: true, name: null, username: null, displayName: null, pfp: null });
    }

    const url =
      "https://api.neynar.com/v2/farcaster/user/bulk-by-address?" +
      new URLSearchParams({
        addresses: addr,
        address_types: "custody_address,verified_address"
      });

    const r = await fetch(url, { headers: { "x-api-key": key } });
    if (!r.ok) {
      return res.status(200).json({ ok: true, name: null, username: null, displayName: null, pfp: null });
    }

    const j = await r.json();
    const u = j?.users?.[0] || null;

    const username = u?.username ? String(u.username) : null;
    const displayName = u?.display_name ? String(u.display_name) : null;
    const pfp = u?.pfp_url ? String(u.pfp_url) : null;

    return res.status(200).json({
      ok: true,
      username,
      displayName,
      pfp,
      name: username ? `${username}.farcaster.eth` : null
    });
  } catch {
    return res.status(200).json({ ok: true, name: null, username: null, displayName: null, pfp: null });
  }
};
