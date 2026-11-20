import { checkoutHandler } from "../_shared/core.mjs";

Deno.serve(checkoutHandler(Deno.env.toObject()));
