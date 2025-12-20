// Vercel Serverless Function: /api/fcname
// address -> "username.farcaster.eth" (via Neynar)
// Response: { name: string|null }

module.exports = async function handler(req, res) {
  try {
    const key = process.env.NEYNAR_API_KEY;
    const addr = String(req.query.addr || "").toLowerCase();

    if (!key || !addr || !addr.startsWith("0x") || addr.length !== 42) {
      return res.status(200).json({ name: null });
    }

    const url =
      "https://api.neynar.com/v2/farcaster/user/bulk-by-address?" +
      new URLSearchParams({
        addresses: addr,
        address_types: "custody_address,verified_address"
      });

    const r = await fetch(url, { headers: { "x-api-key": key } });
    if (!r.ok) return res.status(200).json({ name: null });

    const j = await r.json();
    const u = j?.users?.[0] || null;

    const name = u?.username ? `${u.username}.farcaster.eth` : null;

    res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ name });
  } catch {
    return res.status(200).json({ name: null });
  }
};
