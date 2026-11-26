import { analyticsHandler } from "../_shared/analytics.mjs";

Deno.serve(analyticsHandler(Deno.env.toObject()));
