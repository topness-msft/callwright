# Retell Webhook → Resend Email Notifier

**Serverless**, scale-to-zero webhook handler. Runs ONLY when Retell posts a completed call, then emails you a status summary. No always-on server, no database.

## What it does

When a call completes:
- Retell fires `call_analyzed` webhook → this function
- Verifies signature, extracts outcome (status, booking details, reply, transcript)
- Emails you a formatted summary via Resend

Email looks like:
```
✅ [booked] Eclips Salon & Day Spa — Haircut appointment

The agent successfully booked a men's haircut for Phil at 10:30 AM on Saturday, July 18th.

Status          booked
Business        Eclips Salon & Day Spa
Booked date     Saturday, July 18th
Booked time     10:30 AM
Duration        50s
Call ID         call_d8cc81394abc94ab43ac3518eed

[Transcript]
Agent: Hi, I'm an AI assistant calling on behalf of Phil...
```

## Deploy to Vercel (one-time, 2 minutes)

### 1. Push this folder to a Git repo
```bash
cd webhook
git init
git add .
git commit -m "retell webhook handler"
# push to GitHub/GitLab
```

### 2. Import to Vercel
- Go to [vercel.com/new](https://vercel.com/new)
- Import your repo
- Root directory: `webhook`
- Framework preset: Other

### 3. Set environment variables (in Vercel project settings)
```
RETELL_API_KEY   = key_xxx...       # from Retell dashboard
RESEND_API_KEY   = re_xxx...        # from resend.com
EMAIL_FROM       = calls@yourdomain.com   # must be verified in Resend
EMAIL_TO         = you@example.com
```

### 4. Deploy
Vercel auto-deploys. You'll get a URL like:
```
https://virtuphil-webhook.vercel.app/api/retell-webhook
```

### 5. Register the webhook with Retell

**Option A: Account-level (all agents)**
- Go to Retell dashboard → Settings → Webhooks
- Paste your Vercel URL
- Save

**Option B: Per-agent (selective)**
Use `update-postcall.js` or the setup scripts with `webhook_url`:
```javascript
// in setup-agent-from.js, add before api("/create-agent"):
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
// then in the agent body:
webhook_url: WEBHOOK_URL,
```

## Test it

Place a call (any of your existing scripts), wait ~30s for analysis, check your inbox.

## Cost

- **Vercel**: free tier = 100GB-hrs/mo (plenty for webhook spikes)
- **Resend**: free tier = 3,000 emails/mo
- **Total**: $0 unless you place thousands of calls/month

## Local testing (optional)

```bash
npm install
# mock a Retell payload
node -e "
const h = require('./api/retell-webhook.js');
const call = {
  call_id: 'test',
  retell_llm_dynamic_variables: { business_name: 'Test Co', objective: 'test' },
  call_analysis: { call_successful: true, custom_analysis_data: { status: 'booked' } }
};
console.log(h.buildEmail(call));
"
```

---

Once deployed, you have **optional proactive email** on every call — but the MCP server still works standalone (pull-on-demand from Retell when you ask in chat). Best of both.
