⚡ ComEd Electricity Price Alert Bot

A serverless Telegram bot built using Cloudflare Workers that monitors ComEd hourly electricity prices in real time. The bot automatically sends alerts when prices go negative or spike above user-defined thresholds, helping consumers and energy enthusiasts track grid trends efficiently.

⸻

🚀 Features
	•	Live price tracking: Fetches hourly ComEd electricity prices via API every 5 minutes.
	•	Telegram integration: Sends alerts directly to a Telegram chat using the Bot API.
	•	Smart alert logic:
	•	🔻 Notify when price < 0 ¢/kWh (negative pricing event).
	•	🔺 Notify when price ≥ 10 ¢/kWh (high-price event).
	•	⏱ Reminder every 45 min (negative) or 60 min (high) until condition ends.
	•	🟢 “Back to normal” message when price stabilizes.
	•	Record tracking: Optional record-breaker alerts for new daily highs/lows with a 1 ¢ buffer (≥ 60 min spacing).
	•	No daily cap: Runs continuously using Cloudflare’s Cron triggers.


