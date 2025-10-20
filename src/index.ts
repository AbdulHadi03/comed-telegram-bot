type Env = {
	BOT_TOKEN: string;
	CHAT_ID: string;
  
	// defaults in **cents/kWh**
	MIN_CENTS: string; // e.g. "6.5"
	MAX_CENTS: string; // e.g. "8.5"
  
	STATE: KVNamespace; // KV binding
  };
  
  /**
   * === Behavior Summary ===
   * Bands:
   *   VERY_GREEN: price < 0
   *   GREEN:      0 <= price < user_min
   *   YELLOW:     user_min <= price < user_max
   *   RED:        user_max <= price < 10
   *   VERY_RED:   price >= 10
   *
   * Alerts:
   *   - Enter VERY_GREEN:       "now negative"
   *   - VERY_GREEN reminder:    every 45 min ("remains negative")
   *   - Exit VERY_GREEN:        "negative ended"
   *   - Enter GREEN:            "below your min" (suppressed for 2 min right after "negative ended")
   *   - Enter YELLOW:           "back to normal range"
   *   - Enter RED:              "above your max"
   *   - VERY_RED start:         "extremely high"
   *   - VERY_RED reminder:      every 2 hours ("remains extremely high")
   *   - Drop to RED from VERY_RED: "below 10 but still above max"
   *
   * No daily caps. Thresholds editable via /set?min=..&max=..
   */
  
  const STATE_KEY = "app_state";
  const MIN_KEY = "min_cents";
  const MAX_KEY = "max_cents";
  
  // Timers (ms)
  const NEGATIVE_REMINDER_MS = 45 * 60 * 1000; // 45 min
  const EXTREME_REMINDER_MS  = 2 * 60 * 60 * 1000; // 2 hours
  const GREEN_SUPPRESS_AFTER_NEG_END_MS = 2 * 60 * 1000; // suppress green ping for 2 min after negative ended
  
  // -------- Small helpers --------
  const nowMs = () => Date.now();
  const toISO = (ms: number) => new Date(ms).toISOString();
  const fromISO = (s?: string | null) => (s ? Date.parse(s) : NaN);
  const fmt2 = (n: number) => n.toFixed(2);
  
  async function sendTelegram(env: Env, text: string) {
	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
	  method: "POST",
	  body: new URLSearchParams({ chat_id: env.CHAT_ID, text }),
	});
	if (!res.ok) {
	  console.error("Telegram error:", res.status, await res.text());
	}
  }
  
  async function getCurrentPriceCentsPerKWh(): Promise<number> {
	const url = "https://hourlypricing.comed.com/api?type=5minutefeed";
	const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
	if (!res.ok) throw new Error(`ComEd API ${res.status}`);
	const data: Array<{ millisUTC: string; price: string }> = await res.json();
	if (!Array.isArray(data) || data.length === 0) throw new Error("ComEd API empty");
	const latest = data.reduce((a, b) => (+b.millisUTC > +a.millisUTC ? b : a));
	return parseFloat(latest.price); // already cents/kWh
  }
  
  async function loadThresholds(env: Env): Promise<{ minC: number; maxC: number }> {
	const [minKV, maxKV] = await Promise.all([env.STATE.get(MIN_KEY), env.STATE.get(MAX_KEY)]);
	const minC = parseFloat(minKV ?? env.MIN_CENTS);
	const maxC = parseFloat(maxKV ?? env.MAX_CENTS);
	return { minC, maxC };
  }
  async function saveThresholds(env: Env, minC?: number, maxC?: number) {
	const ops: Promise<any>[] = [];
	if (typeof minC === "number") ops.push(env.STATE.put(MIN_KEY, String(minC)));
	if (typeof maxC === "number") ops.push(env.STATE.put(MAX_KEY, String(maxC)));
	await Promise.all(ops);
  }
  
  // -------- App state in one KV JSON --------
  type Band = "VERY_GREEN" | "GREEN" | "YELLOW" | "RED" | "VERY_RED";
  type AppState = {
	band: Band | null;            // current band
	lastNegativeAlertAt?: string; // ISO when we last sent any negative alert (start/reminder)
	lastExtremeAlertAt?: string;  // ISO when we last sent any extreme alert (start/reminder)
	lastNegativeEndedAt?: string; // ISO when we last announced negative ended (for green suppression)
  };
  
  async function getState(env: Env): Promise<AppState> {
	const raw = await env.STATE.get(STATE_KEY);
	return raw ? JSON.parse(raw) as AppState : { band: null };
  }
  async function saveState(env: Env, s: AppState) {
	await env.STATE.put(STATE_KEY, JSON.stringify(s));
  }
  
  // -------- Band classifier (simple & readable) --------
  function getBand(price: number, minC: number, maxC: number): Band {
	if (price < 0) return "VERY_GREEN";
	if (price < minC) return "GREEN";
	if (price < maxC) return "YELLOW";
	if (price < 10) return "RED";
	return "VERY_RED";
  }
  
  // -------- Core check --------
  async function checkAndNotify(env: Env) {
	const { minC, maxC } = await loadThresholds(env);
	if (!(minC < maxC)) {
	  console.error("Config error: MIN_CENTS must be < MAX_CENTS");
	  return;
	}
  
	let price: number;
	try {
	  price = await getCurrentPriceCentsPerKWh();
	} catch (e: any) {
	  console.error("ComEd fetch failed:", e?.message || e);
	  return;
	}
  
	const s = await getState(env);
	const prevBand = s.band;
	const curBand = getBand(price, minC, maxC);
	const priceStr = `${fmt2(price)} ¢/kWh`;
	const now = nowMs();
  
	// ----- 1) Handle band changes (single, clear conditions) -----
	if (prevBand !== curBand) {
	  // Enter negative
	  if (curBand === "VERY_GREEN") {
		await sendTelegram(env, `🟢⬇️ Electricity price is now negative. Current rate: ${priceStr}.`);
		s.band = curBand;
		s.lastNegativeAlertAt = toISO(now);
		await saveState(env, s);
		return;
	  }
	  // Exit negative
	  if (prevBand === "VERY_GREEN" && (curBand === "GREEN" || curBand === "YELLOW" || curBand === "RED" || curBand === "VERY_RED")) {
		await sendTelegram(env, `⚠️ Negative pricing period has ended. Current rate: ${priceStr}.`);
		s.band = curBand;
		s.lastNegativeEndedAt = toISO(now);
		await saveState(env, s);
		// Continue to check if we need to handle the new band (e.g., entering GREEN)
		// The GREEN suppression logic will handle the timing check
	  }
	  // Enter very red (>=10)
	  if (curBand === "VERY_RED") {
		await sendTelegram(env, `🚨 Electricity price is extremely high. Current rate: ${priceStr}.`);
		s.band = curBand;
		s.lastExtremeAlertAt = toISO(now);
		await saveState(env, s);
		return;
	  }
	  // Drop from very red to red (still above user max)
	  if (prevBand === "VERY_RED" && curBand === "RED") {
		await sendTelegram(
		  env,
		  `⬇️ Price dropped below 10¢ but remains above your maximum threshold (${fmt2(maxC)}¢). Current rate: ${priceStr}.`
		);
		s.band = curBand;
		await saveState(env, s);
		return;
	  }
	  // Enter red (above user max, but <10)
	  if (curBand === "RED" && prevBand !== "VERY_RED") {
		await sendTelegram(
		  env,
		  `🟥 Price exceeded your maximum threshold (${fmt2(maxC)}¢). Current rate: ${priceStr}.`
		);
		s.band = curBand;
		await saveState(env, s);
		return;
	  }
	  // Enter green (below user min, non-negative) — suppress if just ended negative ≤ 2 min ago
	  if (curBand === "GREEN") {
		const endedAt = fromISO(s.lastNegativeEndedAt);
		const recentlyEndedNegative = Number.isFinite(endedAt) && (now - endedAt) < GREEN_SUPPRESS_AFTER_NEG_END_MS;
		if (!recentlyEndedNegative) {
		  await sendTelegram(
			env,
			`🟩 Price dropped below your minimum threshold (${fmt2(minC)}¢). Current rate: ${priceStr}.`
		  );
		}
		s.band = curBand;
		await saveState(env, s);
		return;
	  }
	  // Enter yellow (normal range)
	  if (curBand === "YELLOW") {
		await sendTelegram(env, `🟡 Price returned to the normal range. Current rate: ${priceStr}.`);
		s.band = curBand;
		await saveState(env, s);
		return;
	  }
  
	  // Fallback: just persist new band
	  s.band = curBand;
	  await saveState(env, s);
	}
  
	// ----- 2) Timed reminders (only for VERY_GREEN and VERY_RED) -----
	if (curBand === "VERY_GREEN") {
	  const last = fromISO(s.lastNegativeAlertAt);
	  const due = !Number.isFinite(last) || (now - last) >= NEGATIVE_REMINDER_MS;
	  if (due) {
		await sendTelegram(env, `🟢⬇️ Electricity price remains negative. Current rate: ${priceStr}.`);
		s.lastNegativeAlertAt = toISO(now);
		await saveState(env, s);
	  }
	  return;
	}
  
	if (curBand === "VERY_RED") {
	  const last = fromISO(s.lastExtremeAlertAt);
	  const due = !Number.isFinite(last) || (now - last) >= EXTREME_REMINDER_MS;
	  if (due) {
		await sendTelegram(env, `🚨 Electricity price remains extremely high. Current rate: ${priceStr}.`);
		s.lastExtremeAlertAt = toISO(now);
		await saveState(env, s);
	  }
	  return;
	}
  
	// No periodic reminders for GREEN / YELLOW / RED
  }
  
  // -------- Worker routes --------
  export default {
	async fetch(request: Request, env: Env) {
	  const url = new URL(request.url);
  
	  if (url.pathname === "/ping") {
		await checkAndNotify(env);
		return new Response("ok", { status: 200 });
	  }
  
	  if (url.pathname === "/price") {
		const [state, price, { minC, maxC }] = await Promise.all([
		  getState(env),
		  (async () => { try { return await getCurrentPriceCentsPerKWh(); } catch { return NaN; } })(),
		  loadThresholds(env),
		]);
		return new Response(JSON.stringify({
		  price_cents_per_kwh: Number.isFinite(price) ? +price.toFixed(3) : null,
		  min_cents: +minC.toFixed(3),
		  max_cents: +maxC.toFixed(3),
		  band: state.band,
		  last_negative_alert_at: state.lastNegativeAlertAt ?? null,
		  last_extreme_alert_at: state.lastExtremeAlertAt ?? null,
		  last_negative_ended_at: state.lastNegativeEndedAt ?? null,
		  last_updated_utc: new Date().toISOString(),
		}), { status: 200, headers: { "content-type": "application/json" } });
	  }
  
	  if (url.pathname === "/get") {
		const [{ minC, maxC }, state] = await Promise.all([loadThresholds(env), getState(env)]);
		return new Response(JSON.stringify({
		  min_cents: minC, max_cents: maxC, band: state.band
		}), { status: 200, headers: { "content-type": "application/json" } });
	  }
  
	  if (url.pathname === "/set") {
		const minStr = url.searchParams.get("min");
		const maxStr = url.searchParams.get("max");
  
		let minNum: number | undefined;
		let maxNum: number | undefined;
  
		if (minStr !== null) {
		  minNum = Number(minStr);
		  if (!Number.isFinite(minNum) || minNum < 0) return new Response("bad min", { status: 400 });
		}
		if (maxStr !== null) {
		  maxNum = Number(maxStr);
		  if (!Number.isFinite(maxNum) || maxNum < 0) return new Response("bad max", { status: 400 });
		}
  
		const { minC: curMin, maxC: curMax } = await loadThresholds(env);
		const newMin = minNum ?? curMin;
		const newMax = maxNum ?? curMax;
		if (!(newMin < newMax)) return new Response("min must be < max", { status: 400 });
  
		await saveThresholds(env, newMin, newMax);
		return new Response(JSON.stringify({ min_cents: newMin, max_cents: newMax }), {
		  status: 200, headers: { "content-type": "application/json" }
		});
	  }
  
	  return new Response("ok", { status: 200 });
	},
  
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
	  await checkAndNotify(env);
	},
  };

// type Env = {
// 	BOT_TOKEN: string;
// 	CHAT_ID: string;
  
// 	// thresholds in **cents/kWh**
// 	MIN_CENTS: string;     // e.g., "6.5"
// 	MAX_CENTS: string;     // e.g., "8.5"
  
// 	STATE: KVNamespace;    // KV binding
//   };
  
//   const ALERT_KEY = "alert_state"; // "idle" | "low" | "high"
  
//   // KV keys to allow live tuning via /set
//   const MIN_KEY = "min_cents";
//   const MAX_KEY = "max_cents";
  
//   async function loadThresholds(env: Env): Promise<{ minC: number; maxC: number }> {
// 	const [minKV, maxKV] = await Promise.all([
// 	  env.STATE.get(MIN_KEY),
// 	  env.STATE.get(MAX_KEY),
// 	]);
// 	const minC = parseFloat(minKV ?? env.MIN_CENTS);
// 	const maxC = parseFloat(maxKV ?? env.MAX_CENTS);
// 	return { minC, maxC };
//   }
  
//   async function saveThresholds(env: Env, minC?: number, maxC?: number) {
// 	const ops: Promise<any>[] = [];
// 	if (typeof minC === "number") ops.push(env.STATE.put(MIN_KEY, String(minC)));
// 	if (typeof maxC === "number") ops.push(env.STATE.put(MAX_KEY, String(maxC)));
// 	await Promise.all(ops);
//   }
  
//   async function sendTelegram(env: Env, text: string) {
// 	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
// 	  method: "POST",
// 	  body: new URLSearchParams({ chat_id: env.CHAT_ID, text }),
// 	});
// 	if (!res.ok) {
// 	  const body = await res.text();
// 	  console.error("Telegram error:", res.status, body);
// 	}
//   }
  
//   // Returns **cents/kWh** (e.g., 2.0 means 2.0 ¢/kWh)
//   async function getCurrentPriceCentsPerKWh(): Promise<number> {
// 	const url = "https://hourlypricing.comed.com/api?type=5minutefeed";
// 	const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
// 	if (!res.ok) throw new Error(`ComEd API ${res.status}`);
// 	const data: Array<{ millisUTC: string; price: string }> = await res.json();
// 	if (!Array.isArray(data) || data.length === 0) {
// 	  throw new Error("ComEd API returned empty array");
// 	}
// 	const latest = data.reduce((a, b) => (+b.millisUTC > +a.millisUTC ? b : a));
// 	return parseFloat(latest.price); // already cents/kWh
//   }
  
//   async function checkAndNotify(env: Env) {
// 	const { minC, maxC } = await loadThresholds(env);
// 	if (!(minC < maxC)) {
// 	  console.error("Config error: MIN_CENTS must be < MAX_CENTS");
// 	  return;
// 	}
  
// 	let priceC: number;
// 	try {
// 	  priceC = await getCurrentPriceCentsPerKWh();
// 	} catch (e: any) {
// 	  console.error("ComEd fetch failed:", e?.message || e);
// 	  return; // don’t alert on data fetch errors
// 	}
  
// 	const prev = (await env.STATE.get(ALERT_KEY)) ?? "idle";
  
// 	// if (prev === "idle") {
// 	//   if (priceC < minC) {
// 	// 	await sendTelegram(env, `⚡️ Price BELOW MIN: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 	// 	await env.STATE.put(ALERT_KEY, "low");
// 	//   } else if (priceC > maxC) {
// 	// 	await sendTelegram(env, `⚡️ Price ABOVE MAX: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 	// 	await env.STATE.put(ALERT_KEY, "high");
// 	//   }
// 	// } else if (prev === "low") {
// 	//   if (priceC > maxC) {
// 	// 	await sendTelegram(env, `✅ Recovered ABOVE MAX: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 	// 	await env.STATE.put(ALERT_KEY, "idle");
// 	//   }
// 	// } else if (prev === "high") {
// 	//   if (priceC < minC) {
// 	// 	await sendTelegram(env, `✅ Fell BELOW MIN: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 	// 	await env.STATE.put(ALERT_KEY, "idle");
// 	//   }
// 	// }
// 	if (prev === "idle") {
// 		if (priceC < minC) {
// 		  await sendTelegram(env, `⚡️ BELOW MIN: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 		  await env.STATE.put(ALERT_KEY, "low");
// 		} else if (priceC > maxC) {
// 		  await sendTelegram(env, `⚡️ ABOVE MAX: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 		  await env.STATE.put(ALERT_KEY, "high");
// 		}
// 	  } else if (prev === "low") {
// 		if (priceC > maxC) {
// 		  // crossing out of low band → send "ABOVE MAX"
// 		  await sendTelegram(env, `⚡️ ABOVE MAX: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 		  await env.STATE.put(ALERT_KEY, "idle");
// 		}
// 	  } else if (prev === "high") {
// 		if (priceC < minC) {
// 		  // crossing out of high band → send "BELOW MIN"
// 		  await sendTelegram(env, `⚡️ BELOW MIN: ${priceC.toFixed(2)} ¢/kWh (min=${minC.toFixed(2)}, max=${maxC.toFixed(2)})`);
// 		  await env.STATE.put(ALERT_KEY, "idle");
// 		}
// 	  }
//   }
//   //below and above 
//   //....green orange red....
//   //
//   export default {
// 	async fetch(request: Request, env: Env) {
// 	  const url = new URL(request.url);
  
// 	  if (url.pathname === "/ping") {
// 		await checkAndNotify(env);
// 		return new Response("pinged", { status: 200 });
// 	  }
  
// 	  if (url.pathname === "/price") {
// 		const [state, priceC] = await Promise.all([
// 		  (async () => (await env.STATE.get(ALERT_KEY)) ?? "idle")(),
// 		  (async () => { try { return await getCurrentPriceCentsPerKWh(); } catch { return NaN; } })(),
// 		]);
// 		const { minC, maxC } = await loadThresholds(env);
// 		return new Response(JSON.stringify({
// 		  price_cents_per_kwh: Number.isFinite(priceC) ? +priceC.toFixed(3) : null,
// 		  min_cents: +minC.toFixed(3),
// 		  max_cents: +maxC.toFixed(3),
// 		  state,
// 		  last_updated_utc: new Date().toISOString(),
// 		}), { status: 200, headers: { "content-type": "application/json" } });
// 	  }
  
// 	  if (url.pathname === "/get") {
// 		const [{ minC, maxC }, state] = await Promise.all([
// 		  loadThresholds(env),
// 		  (async () => (await env.STATE.get(ALERT_KEY)) ?? "idle")(),
// 		]);
// 		return new Response(JSON.stringify({ min_cents: minC, max_cents: maxC, state }), {
// 		  status: 200, headers: { "content-type": "application/json" }
// 		});
// 	  }
  
// 	  if (url.pathname === "/set") {
// 		// Accept cents via ?min=...&max=...
// 		const minStr = url.searchParams.get("min");
// 		const maxStr = url.searchParams.get("max");
  
// 		let minNum: number | undefined;
// 		let maxNum: number | undefined;
  
// 		if (minStr !== null) {
// 		  minNum = Number(minStr);
// 		  if (!Number.isFinite(minNum) || minNum < 0) return new Response("bad min", { status: 400 });
// 		}
// 		if (maxStr !== null) {
// 		  maxNum = Number(maxStr);
// 		  if (!Number.isFinite(maxNum) || maxNum < 0) return new Response("bad max", { status: 400 });
// 		}
  
// 		const { minC: curMin, maxC: curMax } = await loadThresholds(env);
// 		const newMin = minNum ?? curMin;
// 		const newMax = maxNum ?? curMax;
// 		if (!(newMin < newMax)) return new Response("min must be < max", { status: 400 });
  
// 		await saveThresholds(env, newMin, newMax);
// 		return new Response(JSON.stringify({ min_cents: newMin, max_cents: newMax }), {
// 		  status: 200, headers: { "content-type": "application/json" }
// 		});
// 	  }
  
// 	  return new Response("ok", { status: 200 });
// 	},
  
// 	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
// 	  await checkAndNotify(env);
// 	},
//   };