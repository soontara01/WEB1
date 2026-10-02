import type { RequestHandler } from 'express';

const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d+)?$/;

/** "1.2.3.4:5678" → "1.2.3.4", "[2001:db8::1]:443" → "2001:db8::1"; bare IPv6 is left alone. */
export function stripPort(ip: string): string {
  return IPV4_WITH_PORT.exec(ip)?.[1] ?? BRACKETED_IPV6.exec(ip)?.[1] ?? ip;
}

/**
 * Azure Application Gateway appends the client's source port to X-Forwarded-For ("ip:port").
 * Express passes that through as req.ip ("1.2.3.4:5678"), which is not a valid IP for logging or
 * any IP-based logic. Shadow req.ip with the port-less address for the rest of the request.
 */
export const normalizeClientIp: RequestHandler = (req, _res, next) => {
  const ip = req.ip;
  if (ip) {
    const clean = stripPort(ip);
    if (clean !== ip) Object.defineProperty(req, 'ip', { value: clean, enumerable: true, configurable: true });
  }
  next();
};
