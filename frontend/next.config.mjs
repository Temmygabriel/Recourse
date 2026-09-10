/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The escrow address and RPC URL are public by nature — an address and an
  // endpoint — so NEXT_PUBLIC_ is correct for them. Nothing else here is
  // secret: this app holds no keys. It signs with the user's own wallet via
  // window.ethereum, so there is no private key anywhere in the frontend, and
  // no server-side secret for a page to leak.
  env: {},
};

export default nextConfig;
