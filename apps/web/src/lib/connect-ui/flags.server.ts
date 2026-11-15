/**
 * Server-side switches for the Connect UI. Read on the server only and passed
 * down as plain booleans, so nothing here reaches the browser bundle.
 *
 * Customer MCP stays OFF unless an operator sets TUGPT_CUSTOMER_MCP_ENABLED=true,
 * and that must only happen after the egress proxy has passed its DNS-pinning,
 * private-address-blocking and bypass-prevention probe
 * (docs/connect/egress-proxy/egress-probe.cjs). Off means: no registering, no
 * tool discovery (which contacts the customer's server), no approval, no
 * activation. Listing, reading stored tools, turning off and deleting stay
 * available because they only reduce exposure.
 */
type Env = Readonly<Record<string, string | undefined>>;

export function customerMcpEnabled(env: Env = process.env): boolean {
  return env.TUGPT_CUSTOMER_MCP_ENABLED?.trim() === 'true';
}
