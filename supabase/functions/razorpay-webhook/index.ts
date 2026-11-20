import { webhookHandler } from "../_shared/core.mjs";

Deno.serve(webhookHandler(Deno.env.toObject()));
