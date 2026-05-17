// Public surface for the Twilio relay layer.

export { computeTwilioSignature, verifyTwilioSignature } from "./signature.js";
export { createTwilioClient, type TwilioClient, type SendSmsInput, type SendSmsResult } from "./client.js";
export {
  route,
  renderRevealBody,
  COPY,
  type RouteInput,
  type RouteResult,
  type RouterUser,
  type RouterPartner,
  type RouterActiveMatch,
  type OutboundAction,
  type PersistInbound,
} from "./conversation.js";
export {
  findUserByPhone,
  loadActiveMatchForUser,
  persistInboundMessage,
  persistOutboundMessage,
  recordDeliveryStatus,
  type TwilioPrisma,
} from "./prisma-deps.js";
export { registerTwilioRoutes, type RegisterOptions } from "./routes.js";
