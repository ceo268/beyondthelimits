import { ticketEmailHandler } from "../_shared/ticket-worker.mjs";

Deno.serve(ticketEmailHandler(Deno.env.toObject()));
