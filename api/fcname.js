// Vercel Serverless Function: /api/fcname
// Returns farcaster username for an ETH address using Neynar.
// Output: { name: "username.farcaster.eth" } or { name: null }

module.exports = async function handler(req, res) {
  try {
    const key = process.env.NEYNAR_API_KEY;
    const addr = String(req.query.addr || "").toLowerCase();

    if (!key || !addr || !addr.startsWith("0x")) {
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
    const u = j?.users?.[0];
    const name = u?.username ? `${u.username}.farcaster.eth` : null;

    // small cache header (optional)
    res.setHeader("cache-control", "s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json({ name });
  } catch (e) {
    return res.status(200).json({ name: null });
  }
};
