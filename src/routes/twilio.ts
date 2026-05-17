import type { FastifyInstance } from "fastify";

// Placeholder route module. The full Twilio webhook implementation
// (signature verification, inbound routing, conversation state machine)
// is built in a later task. For now we expose the endpoints so the
// shape of the API is visible and so smoke tests pass.

export async function registerTwilioRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/twilio/inbound", async (_req, reply) => {
    return reply.code(501).send({ error: "not_implemented", message: "Twilio inbound handler pending" });
  });

  app.post("/webhooks/twilio/status", async (_req, reply) => {
    return reply.code(501).send({ error: "not_implemented", message: "Twilio status callback pending" });
  });
}
