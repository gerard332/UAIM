"""
AI layer for UAIM.

Providers (set AI_PROVIDER in .env):
  anthropic  - Claude via the Anthropic API (needs ANTHROPIC_API_KEY)
  ollama     - a local open-weight model served by Ollama
  demo       - no AI at all; returns a built-in example analysis (for trying the site)
"""
import base64
import copy
import json
import os
import re

import requests

SCHEMA = """{
  "processName": string, "processScope": string (one sentence: trigger to end result),
  "headline": string (max 18 words), "overallScore": integer 0-100,
  "keyFindings": [string, string, string],
  "assumptions": [string] (2-5 assumptions you had to make because the description was silent),
  "impact": {"hoursLostPerMonth": number, "annualCost": number, "cycleTimeNow": string, "cycleTimeTarget": string, "basis": string},
  "steps": [ {"id": string, "name": string, "actor": string, "type": "manual"|"automated"|"decision"|"handoff"|"wait",
    "function": string, "inputs": [string], "outputs": [string],
    "flow": {"processTime": {"v": number, "u": "min"|"h"|"d"|"wk", "quote": string} | null, "waitBefore": {"v": number, "u": "min"|"h"|"d"|"wk", "quote": string} | null,
             "queue": {"v": number, "quote": string} | null, "reworkPct": {"v": number, "quote": string} | null, "valueAdd": {"v": "value"|"necessary"|"waste"}},
    "failureModes": [ {"id": string, "mode": string, "effects": string, "severity": int, "causes": string, "occurrence": int,
      "preventionControls": string, "detectionControls": string, "detection": int, "ap": "H"|"M"|"L",
      "action": string, "owner": string, "confidence": "high"|"medium"|"low"} ] } ],
  "moves": [ {"title": string, "detail": string, "benefit": string, "owner": string, "timeframe": "30 days"|"90 days"|"6 months+", "impact": "high"|"medium"|"low", "effort": "high"|"medium"|"low",
     "fixes": {"stepIds": [string], "riskIds": [string], "waitStepIds": [string], "waitReductionPct": number, "measure": string}} ],
  "executive": {"problems": [ {"title": string, "evidence": string, "stepIds": [string], "riskIds": [string]} ], "exposure": {"summary": string, "items": [string]},
     "firstAction": {"title": string, "why": string, "owner": string, "within": "30 days"|"90 days"}, "targets": [ {"metric": string, "now": string, "target": string, "by": string, "measure": string} ]},
  "dimensions": [ {"name": string, "score": int 1-10, "note": string} ],
  "swot": {"strengths": [string], "weaknesses": [string], "opportunities": [string], "threats": [string]},
  "dataGaps": [ {"step": string, "what": string, "how": string} ],
  "questions": [string]
}"""

METHOD = """PFMEA method (AIAG-VDA, adapted to business processes): split the process into distinct steps (max 12); for each give its function ("verb + object + requirement"), inputs and outputs; give 1-3 realistic failure modes per step with effects, severity S 1-10, causes, occurrence O 1-10, current prevention and detection controls, detection D 1-10; action priority H/M/L (severity weighs most); for H and M a recommended action (prevention before detection) and owner role, else action "None". Scales: S 9-10 legal/regulatory breach or loss of customer, 7-8 major disruption or significant loss, 4-6 moderate rework/delay, 1-3 minor. O 9-10 most runs, 7-8 frequent, 4-6 occasional, 1-3 rare. D 9-10 not caught before customer, 7-8 caught late or by chance, 4-6 routine check, 1-3 automatic/prevented. "confidence" reflects how much the description supports the failure mode (low = mostly assumed). "dimensions" are exactly these seven (translated if the report language isn't English): Efficiency, Clear ownership, Risk and controls, Automation readiness, Customer impact, Ready to scale, Measurability. 3-6 moves, best impact-to-effort first. "swot" gives 3-5 items in each list, one specific sentence each, about this process: strengths and weaknesses are internal to the process (people, steps, systems, controls); opportunities and threats are outside it (technology, customers, competitors, regulation, growth) that the organisation could use or must guard against. Flow (value stream) per step: "processTime" is the hands-on time per case; "waitBefore" is how long a case waits before the step starts; "queue" is how many cases typically wait; "reworkPct" is the share of cases sent back or repeated; units "min", "h", "d" (working day of 8 hours) or "wk" (week), using the unit the text uses (don't convert). Fill a timing ONLY when the customer's text states it, and put the exact words you relied on (a short verbatim extract, max 15 words, that includes the number and the unit) in "quote"; otherwise use null. NEVER estimate, guess or invent timings, volumes or queues. "valueAdd" is your judgement of the step: "value" (the customer would pay for it), "necessary" (needed for control or compliance but not valued by the customer) or "waste" (waiting, re-keying, chasing, duplicate checks). "dataGaps" lists 3-8 timings or facts the team should measure to complete the value stream (which step, what to measure, how to measure it simply). Keep each text field under 25 words. Write every text field in plain business language for a non-specialist: never mention PFMEA, FMEA, RPN, AIAG or "action priority" in any text."""


class AIError(Exception):
    pass


# Report languages (code -> English name used in prompts)
LANGS = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese", "nl": "Dutch",
    "pl": "Polish", "sv": "Swedish", "da": "Danish", "no": "Norwegian (Bokmal)", "fi": "Finnish", "is": "Icelandic",
    "cs": "Czech", "sk": "Slovak", "hu": "Hungarian", "ro": "Romanian", "bg": "Bulgarian", "el": "Greek", "hr": "Croatian",
    "sl": "Slovenian", "sr": "Serbian (Latin script)", "et": "Estonian", "lv": "Latvian", "lt": "Lithuanian", "ga": "Irish",
    "mt": "Maltese", "ca": "Catalan", "cy": "Welsh", "uk": "Ukrainian", "tr": "Turkish",
}


NAMING = "In all text you write, call the value stream analysis the \"Process Efficiency Analysis\" (never \"value stream\")."
ISSUE_ANSWERS = {"yes": "Yes, there are known issues.", "no": "No known issues.", "unsure": "I'm not sure."}


def issues_block(i):
    """What the user told us about known problems with the process: supplementary context for every stage,
    never a limit on the review. Empty when the question wasn't answered."""
    i = i or {}
    ans, txt = i.get("knownIssues") or "", (i.get("issuesText") or "").strip()
    if ans not in ISSUE_ANSWERS and not txt:
        return ""
    lines = ["", "", "USER-REPORTED ISSUES (asked when the process was submitted: \"Are there any known issues or problems with this process?\")",
             "Answer: " + ISSUE_ANSWERS.get(ans, "(not answered)")]
    if txt:
        lines.append("Their description: " + txt)
    lines.append(
        "How to use this: it is supplementary context, not the scope of the review. Always assess the whole process independently "
        "(efficiency, effectiveness, ownership, controls, risks, quality and customer impact) and look for problems and opportunities the user has not mentioned. "
        "Consider the reported issues and their operational impact, check whether the process information supports them, and consider possible root causes, "
        "contributing factors and consequences, without treating them as proven facts. \"No known issues\" or \"I'm not sure\" does not mean the process has no problems. "
        "Where you rely on what the user reported, say so; keep it distinct from findings supported by the process information and from your own inferences, "
        "and state assumptions where information is insufficient. Never invent performance data, root causes or evidence.")
    return "\n".join(lines)


def lang_rule(i):
    """The language rule for every prompt, followed by the user-reported issues (if any), so every stage sees them."""
    code = (i or {}).get("lang") or "en"
    name = LANGS.get(code, "English")
    if code == "en":
        return "Write all text in British English. " + NAMING + issues_block(i)
    return (f"Write every text value in {name}, including step names, findings, actions, owners, dimension names and notes. "
            "Keep the JSON keys and the fixed enum values (such as \"manual\", \"H\", \"high\", \"30 days\") exactly as specified in English, "
            "and write \"None\" exactly as \"None\" when there is no action. Do not mix in English anywhere else. " + NAMING + issues_block(i))




def _sizing(i):
    runs, rate, cur = i.get("runs"), i.get("rate"), i.get("cur", "GBP")
    if runs or rate:
        return (f"Sizing inputs: runs per month = {runs or 'not given (estimate)'}; "
                f"loaded cost per staff hour = {str(rate) + ' ' + cur if rate else 'not given (estimate)'}.")
    return "No sizing inputs given: estimate volume and hourly cost conservatively and say so in impact.basis."


def first_prompt(desc, i, has_image=False):
    body = ("The process:\n\n" + desc) if desc else ""
    if has_image:
        body += ("\n\n" if body else "") + "The process is (also) shown in the attached image(s), which may be pages of a document or a process diagram. Read every step from them."
    return f"""You are a senior quality and operations engineer running a Process FMEA on a business process, and writing for a company director. Be specific to the steps, roles and systems described. Do not invent facts; when you must assume, say so in "assumptions", keep ratings conservative, and lower "confidence".
{METHOD}
Executive priority: {i.get('priority', 'Balanced review')}. Company size: {i.get('size', 'Not specified')}. Currency: {i.get('cur', 'GBP')}. {_sizing(i)}
{lang_rule(i)}
Use "id": "new" for every step and every failure mode.
Return ONLY a JSON object, no prose and no code fences, with exactly this shape:
{SCHEMA}

{body}"""


def rerun_prompt(analysis, comments, notes, i):
    slim = copy.deepcopy(analysis)
    slim.pop("meta", None)
    for s in slim.get("steps", []):
        s["teamEditedText"] = bool(s.pop("textEdited", False))
        for f in s.get("failureModes", []):
            f["teamEditedRatings"] = bool(f.pop("edited", False))
            f["teamEditedText"] = bool(f.pop("textEdited", False))
            f["actionStatus"] = f.pop("status", "open")
            f.pop("due", None)
            f.pop("ownerSet", None)
    by_fm = {}
    for c in comments:
        by_fm.setdefault(c["fmId"], []).append(c["text"])
    return f"""You are a senior quality and operations engineer updating a living Process FMEA after the process team reviewed it. The team's feedback is the best evidence you have about how the process really works: apply it.
{METHOD}
Rules for this update:
- Keep the same "id" for every step and every failure mode that still applies (even if you reword it). Use "id": "new" only for genuinely new ones. Drop items the team says do not apply.
- Return each existing step's "flow" exactly as given: the team's timings are measured or confirmed data and must not be changed. For new steps, fill flow timings only where the team notes or the original description state them, with a verbatim "quote".
- Where "teamEditedRatings" is true, keep that failure mode's severity, occurrence and detection exactly as given.
- Where "teamEditedText" is true, the team wrote or corrected that wording: keep it unless a team note asks for a change.
- Add, remove, merge or rename steps if the team's notes say the description was wrong.
- Raise "confidence" where the team confirmed something; lower it where they disputed it.
- Update headline, findings, impact, moves, dimensions and questions to match.
- Also return "changeSummary": [string] listing 2-8 concrete changes you made and why (max 20 words each).
- The team's notes may be in any language; the review itself stays in the report language.
Executive priority: {i.get('priority', 'Balanced review')}. Company size: {i.get('size', 'Not specified')}. Currency: {i.get('cur', 'GBP')}. {_sizing(i)}
{lang_rule(i)}

CURRENT ANALYSIS (JSON):
{json.dumps(slim, ensure_ascii=False)}

TEAM NOTES BY FAILURE MODE ID (JSON; key "general" = notes about the whole process):
{json.dumps(by_fm, ensure_ascii=False)}

ADDITIONAL INSTRUCTIONS FROM THE PERSON RUNNING THIS UPDATE:
{notes or "(none)"}

Return ONLY a JSON object, no prose and no code fences, with this shape plus "changeSummary":
{SCHEMA}"""


def _parse_json(text):
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise AIError("The AI did not return a JSON analysis.")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise AIError(f"The AI returned malformed JSON ({e.msg}). Try again.")


def _anthropic(prompt, images=None):
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise AIError("ANTHROPIC_API_KEY is not set on the server.")
    content = []
    for image in images or []:
        content.append({"type": "image", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}})
    content.append({"type": "text", "text": prompt})
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
                  "max_tokens": int(os.environ.get("ANTHROPIC_MAX_TOKENS", "16000")),
                  "messages": [{"role": "user", "content": content}]},
            timeout=int(os.environ.get("AI_TIMEOUT", "280")),
        )
    except requests.RequestException as e:
        raise AIError(f"Could not reach the Anthropic API: {e.__class__.__name__}.")
    if r.status_code == 429:
        raise AIError("The AI service is busy (rate limited). Wait a minute and try again.")
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("message", "")
        except ValueError:
            msg = r.text[:200]
        raise AIError(f"Anthropic API error {r.status_code}: {msg}")
    data = r.json()
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    if data.get("stop_reason") == "max_tokens":
        raise AIError("The analysis was too long and got cut off. Raise ANTHROPIC_MAX_TOKENS or shorten the description.")
    return _parse_json(text)

def _mistral(prompt, images=None):
    """The Mistral API (api.mistral.ai). MISTRAL_API_KEY and MISTRAL_MODEL in .env."""
    key = os.environ.get("MISTRAL_API_KEY", "").strip()
    if not key:
        raise AIError("MISTRAL_API_KEY is not set on the server.")
    content = []
    for image in images or []:
        content.append({"type": "image_url", "image_url": {"url": f"data:{image['media_type']};base64,{image['data']}"}})
    content.append({"type": "text", "text": prompt})
    try:
        r = requests.post(
            "https://api.mistral.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
            json={"model": os.environ.get("MISTRAL_MODEL", "mistral-large-latest"),
                  "max_tokens": int(os.environ.get("MISTRAL_MAX_TOKENS", "16000")),
                  "temperature": float(os.environ.get("MISTRAL_TEMPERATURE", "0.3")),
                  "messages": [{"role": "user", "content": content}]},
            timeout=int(os.environ.get("AI_TIMEOUT", "280")),
        )
    except requests.RequestException as e:
        raise AIError(f"Could not reach the Mistral API: {e.__class__.__name__}.")
    if r.status_code == 429:
        raise AIError("The AI service is busy (rate limited). Wait a minute and try again.")
    if r.status_code >= 400:
        try:
            msg = r.json().get("message", "") or r.json().get("detail", "")
        except ValueError:
            msg = r.text[:200]
        raise AIError(f"Mistral API error {r.status_code}: {msg}")
    data = r.json()
    if data.get("choices") and data["choices"][0].get("finish_reason") == "length":
        raise AIError("The analysis was too long and got cut off. Raise MISTRAL_MAX_TOKENS or shorten the description.")
    return _parse_json(data.get("choices", [{}])[0].get("message", {}).get("content", ""))

def _ollama(prompt, images=None):
    url = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
    model = os.environ.get("OLLAMA_MODEL", "qwen3:32b")
    msg = {"role": "user", "content": prompt}
    if images:
        msg["images"] = [i["data"] for i in images]  # only works with vision-capable models
    try:
        r = requests.post(f"{url}/api/chat", json={
            "model": model, "messages": [msg], "stream": False, "format": "json",
            "options": {"num_ctx": int(os.environ.get("OLLAMA_NUM_CTX", "32768")), "temperature": 0.3},
        }, timeout=int(os.environ.get("AI_TIMEOUT", "280")))
    except requests.RequestException as e:
        raise AIError(f"Could not reach Ollama at {url}: {e.__class__.__name__}. Is it running?")
    if r.status_code >= 400:
        raise AIError(f"Ollama error {r.status_code}: {r.text[:200]}")
    return _parse_json(r.json().get("message", {}).get("content", ""))


def _demo(prompt, images=None):
    staged = _demo_stage(prompt)
    if staged is not None:
        return staged
    if prompt.startswith("You are helping build a value stream map"):
        m = re.search(r"STEPS \(JSON\):\n(.*?)\n\nCUSTOMER", prompt, re.S)
        steps = json.loads(m.group(1)) if m else []
        out = []
        for i, st in enumerate(steps):
            fl = {"valueAdd": {"v": "waste" if i in (2, 3, 6) else "necessary" if i in (4, 8) else "value"}}
            if "once a day" in prompt and i == 3:
                fl["waitBefore"] = {"v": 1, "u": "d", "quote": "Finance checks the inbox once a day"}
            out.append({"id": st.get("id"), "flow": fl})
        return {"steps": out, "dataGaps": [{"step": steps[1]["name"] if len(steps) > 1 else "", "what": "Minutes spent checking and re-keying each order",
                                            "how": "Time 10 requests with a stopwatch"}]}
    if "Write a SWOT analysis of this process" in prompt:
        path = os.path.join(os.path.dirname(__file__), "demo_analysis.json")
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)["swot"]
    if prompt.startswith("Translate the values of this JSON object"):
        return json.loads(prompt[prompt.index("{", prompt.index("Return ONLY")):])  # demo: wording stays in English
    if "tailored briefing" in prompt:
        m = re.search(r"for one reader: the (.+?)\.\n", prompt)
        who = m.group(1) if m else "this reader"
        return {"headline": f"Demo mode: this is where the {who} version would appear.",
                "summary": f"With a real AI connected, this section is rewritten for the {who}, using the same facts, ratings and costs as the general report.",
                "metrics": [{"label": "Avoidable cost / year", "value": "\u00a359,400", "note": "from the general analysis"},
                            {"label": "High-priority risks", "value": "6 of 13", "note": "failure modes"}],
                "keyPoints": ["Key points chosen for this reader appear here.", "The order and wording follow their priorities.", "Facts never differ between audience versions."],
                "decisions": [{"decision": "Decisions for this reader appear here", "why": "Each one explains why it matters to them."}],
                "watchOuts": ["Set AI_PROVIDER to anthropic, mistral or ollama to generate real tailored versions."]}
    path = os.path.join(os.path.dirname(__file__), "demo_analysis.json")
    with open(path, encoding="utf-8") as fh:
        a = json.load(fh)
    if "changeSummary" in prompt:  # re-run: pretend to apply notes, keep ids
        m = re.search(r"CURRENT ANALYSIS \(JSON\):\n(.*)\n\nTEAM NOTES", prompt, re.S)
        if m:
            a = json.loads(m.group(1))
            for s in a.get("steps", []):
                for f in s.get("failureModes", []):
                    f.pop("teamEditedRatings", None)
                    f.pop("actionStatus", None)
        a["changeSummary"] = ["Demo mode: no AI was called, so the analysis is unchanged.",
                              "Set AI_PROVIDER to anthropic or ollama to apply the team's notes for real."]
    return a


SWOT_SCHEMA = """{"strengths": [string], "weaknesses": [string], "opportunities": [string], "threats": [string]}"""


def swot_prompt(analysis, comments, inputs=None):
    slim = copy.deepcopy(analysis)
    slim.pop("meta", None)
    slim.pop("swot", None)
    return f"""You are a senior operations and strategy advisor. Below is a completed review of a business process. Write a SWOT analysis of this process.
Give 3-5 items in each list, one specific sentence each, based only on the review and the team notes (never invent facts or numbers).
Strengths and weaknesses are internal to the process (people, steps, systems, controls). Opportunities and threats are outside it (technology, customers, competitors, regulation, growth) that the organisation could use or must guard against.
{lang_rule(inputs)} Never mention PFMEA, FMEA, RPN or AIAG.

REVIEW (JSON):
{json.dumps(slim, ensure_ascii=False)}

TEAM NOTES:
{json.dumps([c["text"] for c in comments][:40], ensure_ascii=False)}

Return ONLY a JSON object, no prose and no code fences, with exactly this shape:
{SWOT_SCHEMA}"""


def clean_swot(r):
    out = {}
    for k in ("strengths", "weaknesses", "opportunities", "threats"):
        v = (r or {}).get(k) if isinstance(r, dict) else None
        out[k] = [str(x)[:400] for x in (v or []) if str(x).strip()][:6]
    return out if any(out.values()) else None


def run_swot(prompt):
    r = clean_swot(run_json(prompt))
    if not r:
        raise AIError("The SWOT analysis came back empty. Try again.")
    return r


def flow_prompt(analysis, source_text, comments, inputs=None):
    steps = [{"id": st.get("id"), "name": st.get("name"), "actor": st.get("actor"), "function": st.get("function")} for st in analysis.get("steps", [])]
    return f"""You are helping build a value stream map of a business process. Below are the process steps and the customer's own description of the process, plus the team's notes.
For each step, extract ONLY timings and flow facts that the text explicitly states: "processTime" (hands-on time per case), "waitBefore" (how long a case waits before the step starts), "queue" (how many cases typically wait) and "reworkPct" (share of cases sent back or repeated). Units: "min", "h", "d" (working day of 8 hours) or "wk" (week), using the unit the text uses (don't convert). For each value give a short verbatim "quote" (max 15 words, copied exactly, including the number and unit) from the text you relied on. If the text doesn't state it, use null. NEVER estimate, guess or invent numbers.
Also judge "valueAdd" for each step: "value" (the customer would pay for it), "necessary" (needed for control or compliance) or "waste" (waiting, re-keying, chasing, duplicate checks).
Then list "dataGaps": 3-8 timings or facts the team should measure to complete the map (which step, what to measure, how to measure it simply). {lang_rule(inputs)}

STEPS (JSON):
{json.dumps(steps, ensure_ascii=False)}

CUSTOMER'S DESCRIPTION:
{source_text or "(none)"}

TEAM NOTES:
{json.dumps([c["text"] for c in comments][:40], ensure_ascii=False)}

Return ONLY a JSON object, no prose and no code fences, with this shape:
{{"steps": [ {{"id": string, "flow": {{"processTime": {{"v": number, "u": string, "quote": string}} | null, "waitBefore": {{...}} | null, "queue": {{"v": number, "quote": string}} | null, "reworkPct": {{"v": number, "quote": string}} | null, "valueAdd": {{"v": "value"|"necessary"|"waste"}}}} }} ],
 "dataGaps": [ {{"step": string, "what": string, "how": string}} ]}}"""



# ======================================================================
# Step-by-step journey: one prompt per stage. Each stage only builds on
# what the user has already confirmed in the earlier stages.
# ======================================================================
PLAIN = "Write every text field in plain business language for a non-specialist, each under 25 words. Never mention PFMEA, FMEA, RPN, AIAG or \"action priority\"."


def _slim(analysis, keep=None):
    a = copy.deepcopy(analysis)
    for k in ("meta", "_inputs"):
        a.pop(k, None)
    if keep is not None:
        a = {k: v for k, v in a.items() if k in keep}
    return a


def steps_prompt(desc, i, has_image=False):
    body = ("The process:\n\n" + desc) if desc else ""
    if has_image:
        body += ("\n\n" if body else "") + "The process is (also) shown in the attached image(s). Read every step from them."
    return f"""TASK: STEPS
You are a senior operations advisor. Read the business process described below and set out its steps, in order, so the team can check them before anything else is analysed.
- Split the process into its distinct steps (max 12, merge trivial sub-actions). For each step give: a short name, who does it ("actor"), its type, and its purpose ("function": verb + object + standard).
- Use only what the description says or clearly implies. Where you had to assume something (a step that seems to be missing, an unclear order, who does a step), list it in "assumptions".
- In "openPoints", list 0-5 short questions the team should answer to get the steps right (e.g. a step that may happen in parallel, or a decision with no clear owner).
{PLAIN} {lang_rule(i)}
Return ONLY a JSON object, no prose and no code fences:
{{"processName": string, "processScope": string (one sentence: trigger to end result),
 "steps": [ {{"id": "new", "name": string, "actor": string, "type": "manual"|"automated"|"decision"|"handoff"|"wait", "function": string}} ],
 "assumptions": [string] (1-5), "openPoints": [string]}}

{body}"""


def sipoc_prompt(analysis, desc, i, comments):
    steps = [{k: st.get(k) for k in ("id", "name", "actor", "type", "function")} for st in analysis.get("steps", [])]
    return f"""TASK: SIPOC
You are a senior operations advisor. The team has confirmed the process steps below. Set out the SIPOC: Suppliers, Inputs, Process, Outputs and Customers.
- For the process as a whole: the inputs it needs and, for each input, which supplier(s) provide it ("from"); the outputs it produces and, for each output, which customer(s) receive it ("to"). Every name in "from" must appear in "suppliers", and every name in "to" in "customers". Suppliers and customers can be people, teams, other organisations or systems.
- For each step (keep each "id" exactly as given): the step's own suppliers, inputs, outputs and customers (internal or external).
- Use only what the steps, the description and the team's notes say or clearly imply. List anything you had to assume in "assumptions".
{PLAIN} {lang_rule(i)}

CONFIRMED STEPS (JSON):
{json.dumps(steps, ensure_ascii=False)}

ORIGINAL DESCRIPTION:
{desc or "(none)"}

TEAM NOTES:
{json.dumps([c["text"] for c in comments][:40], ensure_ascii=False)}

Return ONLY a JSON object, no prose and no code fences:
{{"sipoc": {{"suppliers": [string], "inputs": [ {{"name": string, "from": [string]}} ], "outputs": [ {{"name": string, "to": [string]}} ], "customers": [string]}},
 "steps": [ {{"id": string, "suppliers": [string], "inputs": [string], "outputs": [string], "customers": [string]}} ],
 "assumptions": [string] (0-5)}}"""


def risk_prompt(analysis, desc, i, comments):
    steps = [{k: st.get(k) for k in ("id", "name", "actor", "type", "function", "suppliers", "inputs", "outputs", "customers")} for st in analysis.get("steps", [])]
    return f"""TASK: RISK
You are a senior quality and operations engineer. The team has confirmed the process steps below. For EVERY step, analyse how it can go wrong.
For each step give 1-3 realistic failure modes ("what can go wrong": not done, late, partly done, done wrong, done twice), each with: effects (on the next step, the business and the customer), severity 1-10, causes, occurrence 1-10, current prevention controls, current detection controls, detection 1-10, priority "ap" H/M/L (severity weighs most, then occurrence, then detection), a recommended action (prevention before detection) and an owner role for H and M (else action "None"), and "confidence" high/medium/low (low = mostly assumed).
Scales: severity 9-10 legal/regulatory breach or loss of customer, 7-8 major disruption or significant loss, 4-6 moderate rework or delay, 1-3 minor. Occurrence 9-10 most runs, 7-8 frequent, 4-6 occasional, 1-3 rare. Detection 9-10 not caught before the customer, 7-8 caught late or by chance, 4-6 routine check, 1-3 automatic or prevented.
Keep each step's "id" exactly as given. Base everything on the steps, the original description and the team's notes; don't invent facts.
{PLAIN} {lang_rule(i)}

CONFIRMED STEPS (JSON):
{json.dumps(steps, ensure_ascii=False)}

ORIGINAL DESCRIPTION:
{desc or "(none)"}

TEAM NOTES:
{json.dumps([c["text"] for c in comments][:40], ensure_ascii=False)}

Return ONLY a JSON object, no prose and no code fences:
{{"steps": [ {{"id": string, "failureModes": [ {{"id": "new", "mode": string, "effects": string, "severity": int, "causes": string, "occurrence": int,
  "preventionControls": string, "detectionControls": string, "detection": int, "ap": "H"|"M"|"L", "action": string, "owner": string, "confidence": "high"|"medium"|"low"}} ] }} ]}}"""


def summary_prompt(analysis, flow_calc, desc, i, comments):
    return f"""TASK: SUMMARY
You are a senior operations advisor writing for a company director. The team has confirmed the SIPOC, the risk analysis and the value stream of a process (below). Write the SWOT analysis and the executive summary.
- SWOT: 3-5 items per list, one specific sentence each. Strengths and weaknesses are internal to the process (people, steps, systems, controls); opportunities and threats are outside it (technology, customers, competitors, regulation, growth).
- Executive summary ("executive"): exactly 3 "problems", biggest first, each with the evidence, its "basis" ("reported" = mainly what the user reported, "evidence" = supported by the process information or the team's confirmed data, "inferred" = your own inference) and the ids of the steps and risks (failure modes) it is about; the biggest problems may or may not be the ones the user reported; if the user reported issues, also give "issueCheck": one entry per reported issue with your assessment ("supported", "partly supported", "not supported" or "unclear") against the process information, the evidence for that assessment ("note"), the most probable cause in this process ("likelyCause", based on the steps, risks and timings; say so if it is uncertain), the most probable answer: what would most likely resolve it ("answer", practical and specific), and the numbers of the recommended moves that address it ("moves", 1-based); every reported issue the analysis supports at least partly should be addressed by at least one move; the business "exposure" (what it costs, which customers and obligations are at risk); the one "firstAction" management should take first, and why; and 2-4 measurable "targets" (metric, current level, target level, by when, how to measure it). Use the confirmed timings and figures where they exist.
- Cost ("impact.breakdown"): 2-5 rows, each one thing time or money is lost on: items per month, minutes lost per item, hourly staff cost, and any other monthly cost (such as wrong refunds or penalties; 0 if none), with the basis. Use the sizing inputs and the confirmed timings where they exist, otherwise estimate conservatively and say so in the basis. Set "annualCost" to the sum of (items x minutes / 60 x hourly cost + other monthly cost) x 12, and "hoursLostPerMonth" to the sum of items x minutes / 60.
- Summary: a headline (max 18 words), 3 key findings, an overall health score 0-100, cycle time now and target, 3-6 recommended moves (best impact-to-effort first). For each move give "fixes": the ids of the steps it changes, of the risks it reduces, of the steps whose waiting time it cuts, the share of that waiting it should remove (a percentage, an estimate), and how to measure the result. Also give each move a conservative "savingPerYear": what it saves per year in the review's currency (waiting, rework, avoided failures), estimated from the sizing inputs and the confirmed timings; it is only shown to the user where the waiting-time data cannot calculate the saving. Where a problem causes both risk and waiting, say how the move addresses both. And a scorecard with exactly these seven dimensions (translated if not English): Efficiency, Clear ownership, Risk and controls, Automation readiness, Customer impact, Ready to scale, Measurability.
Executive priority: {i.get('priority', 'Balanced review')}. Company size: {i.get('size', 'Not specified')}. Currency: {i.get('cur', 'GBP')}. {_sizing(i)}
{PLAIN} {lang_rule(i)}

CONFIRMED REVIEW (JSON):
{json.dumps(_slim(analysis, ["processName", "processScope", "sipoc", "steps", "assumptions", "dataGaps"]), ensure_ascii=False)}

CALCULATED VALUE-STREAM TOTALS (minutes; null = unknown):
{json.dumps(flow_calc, ensure_ascii=False)}

TEAM NOTES:
{json.dumps([c["text"] for c in comments][:40], ensure_ascii=False)}

Return ONLY a JSON object, no prose and no code fences:
{{"swot": {{"strengths": [string], "weaknesses": [string], "opportunities": [string], "threats": [string]}},
 "headline": string, "keyFindings": [string, string, string], "overallScore": integer,
 "impact": {{"hoursLostPerMonth": number, "annualCost": number, "cycleTimeNow": string, "cycleTimeTarget": string, "basis": string,
   "breakdown": [ {{"label": string, "volumePerMonth": number, "minutesPerItem": number, "hourlyRate": number, "extraCostPerMonth": number, "basis": string}} ]}},
 "executive": {{"problems": [ {{"title": string, "evidence": string, "basis": "reported"|"evidence"|"inferred", "stepIds": [string], "riskIds": [string]}} ], "exposure": {{"summary": string, "items": [string]}},
   "firstAction": {{"title": string, "why": string, "owner": string, "within": "30 days"|"90 days"}}, "targets": [ {{"metric": string, "now": string, "target": string, "by": string, "measure": string}} ]}},
 "issueCheck": [ {{"issue": string, "assessment": "supported"|"partly supported"|"not supported"|"unclear", "note": string, "likelyCause": string, "answer": string, "moves": [integer]}} ],
 "moves": [ {{"title": string, "detail": string, "benefit": string, "owner": string, "timeframe": "30 days"|"90 days"|"6 months+", "impact": "high"|"medium"|"low", "effort": "high"|"medium"|"low",
   "fixes": {{"stepIds": [string], "riskIds": [string], "waitStepIds": [string], "waitReductionPct": number, "measure": string}}, "savingPerYear": number}} ],
 "dimensions": [ {{"name": string, "score": int 1-10, "note": string}} ]}}"""


def raci_prompt(analysis, i, comments):
    steps = [{k: st.get(k) for k in ("id", "name", "actor", "suppliers", "customers")} | {"actions": [f.get("action") for f in st.get("failureModes", []) if f.get("action") and f.get("action") != "None"]}
             for st in analysis.get("steps", [])]
    return f"""TASK: RACI
You are a senior operations advisor. Build a RACI matrix for the process steps below: for each step, which role is Responsible (does the work), Accountable (owns the outcome and signs off; exactly one per step), Consulted (gives input before) and Informed (told after).
- Roles: use the roles that appear in the steps (actors, suppliers, customers) and in the recommended actions' owners; add an accountable manager role only where none exists. 3-8 roles. Use job roles, not people's names.
- Each cell is one of "R", "A", "R/A" (does the work and owns it), "C", "I" or "" (not involved).
- "observations": 2-5 short points about ownership problems you can see (no single owner, one person doing too much, someone who should be informed but isn't, approvals with no deputy).
{PLAIN} {lang_rule(i)}

CONFIRMED STEPS (JSON):
{json.dumps(steps, ensure_ascii=False)}

TEAM NOTES:
{json.dumps([c["text"] for c in comments][:40], ensure_ascii=False)}

Return ONLY a JSON object, no prose and no code fences:
{{"roles": [string], "rows": [ {{"stepId": string, "cells": {{"<role>": "R"|"A"|"R/A"|"C"|"I"|""}} }} ], "observations": [string]}}"""


def _demo_stage(prompt):
    path = os.path.join(os.path.dirname(__file__), "demo_analysis.json")
    with open(path, encoding="utf-8") as fh:
        demo = json.load(fh)
    def steps_in(p, marker):
        m = re.search(marker + r" \(JSON\):\n(.*?)\n\n", p, re.S)
        return json.loads(m.group(1)) if m else []
    if prompt.startswith("TASK: STEPS"):
        out = {k: demo[k] for k in ("processName", "processScope", "assumptions")}
        out["openPoints"] = ["Does finance review every request, or only those over \u00a3200?", "Who approves refunds when the operations manager is away?"]
        out["steps"] = [{k: st[k] for k in ("name", "actor", "type", "function")} | {"id": "new"} for st in demo["steps"]]
        return out
    if prompt.startswith("TASK: SIPOC"):
        steps = steps_in(prompt, "CONFIRMED STEPS")
        return {"sipoc": demo["sipoc"], "assumptions": ["Stripe holds the payment record used for each refund."],
                "steps": [{"id": st["id"]} | {k: demo["steps"][i % len(demo["steps"])][k] for k in ("suppliers", "inputs", "outputs", "customers")} for i, st in enumerate(steps)]}
    if prompt.startswith("TASK: RISK"):
        steps = steps_in(prompt, "CONFIRMED STEPS")
        return {"steps": [{"id": st["id"], "failureModes": copy.deepcopy(demo["steps"][i % len(demo["steps"])]["failureModes"])} for i, st in enumerate(steps)]}
    if prompt.startswith("TASK: SUMMARY"):
        out = copy.deepcopy({k: demo[k] for k in ("swot", "headline", "keyFindings", "overallScore", "impact", "moves", "dimensions", "executive")})
        rv = json.loads(prompt.split("CONFIRMED REVIEW (JSON):\n", 1)[1].split("\n\nCALCULATED", 1)[0])
        sids = [s.get("id") for s in rv.get("steps", [])]
        fids = [[f.get("id") for f in s.get("failureModes", [])] for s in rv.get("steps", [])]
        sid = lambda i: sids[i] if i < len(sids) else None
        fid = lambda i, j: fids[i][j] if i < len(fids) and j < len(fids[i]) else None
        def refs(o):  # the demo refers to steps and risks by position; turn them into this review's ids
            o["stepIds"] = [x for x in (sid(i) for i in o.pop("stepIdx", [])) if x]
            o["riskIds"] = [x for x in (fid(i, j) for i, j in o.pop("riskIdx", [])) if x]
            if "waitStepIdx" in o:
                o["waitStepIds"] = [x for x in (sid(i) for i in o.pop("waitStepIdx")) if x]
        for p in out["executive"]["problems"]:
            refs(p)
        if "USER-REPORTED ISSUES" in prompt and "Answer: Yes" in prompt:
            out["issueCheck"] = copy.deepcopy(demo.get("issueCheck") or [])
        for m in out["moves"]:
            refs(m["fixes"])
        return out
    if prompt.startswith("TASK: RACI"):
        steps = steps_in(prompt, "CONFIRMED STEPS")
        rows = demo["raci"]["rows"]
        return {"roles": demo["raci"]["roles"], "observations": demo["raci"]["observations"],
                "rows": [{"stepId": st["id"], "cells": rows[i % len(rows)]["cells"]} for i, st in enumerate(steps)]}
    return None

def labels_prompt(lang, labels):
    name = LANGS.get(lang, "English")
    return f"""Translate the values of this JSON object from English into {name}, for a professional business report.
Rules: keep every key exactly as it is; keep placeholders such as {{n}}, {{total}}, {{date}}, {{name}}, {{who}}, {{version}}, {{status}}, {{text}}, {{x}}, {{p}}, {{t}} and {{forWho}} exactly as they are, in a natural position; keep values that are in CAPITALS in capitals; keep "|" separators and spacing; use natural, concise business wording.
Return ONLY the translated JSON object, no prose and no code fences.

{json.dumps(labels, ensure_ascii=False)}"""


def run_labels(lang, labels):
    """Translate fixed report wording. Anything missing or broken is retried once, so reports don't mix languages."""
    out = {}
    todo = dict(labels)
    for _ in range(2):
        if not todo:
            break
        r = run_json(labels_prompt(lang, todo))
        for k, v in todo.items():
            t = r.get(k)
            if isinstance(t, str) and t.strip() and all(p in t for p in re.findall(r"\{\w+\}", v)):
                out[k] = t[:600]
        todo = {k: v for k, v in labels.items() if k not in out}
    return out


def run_json(prompt, images=None):
    provider = os.environ.get("AI_PROVIDER", "demo").lower()
    fn = {"anthropic": _anthropic, "mistral": _mistral, "ollama": _ollama, "demo": _demo}.get(provider)
    if not fn:
        raise AIError(f"Unknown AI_PROVIDER '{provider}'. Use anthropic, mistral, ollama or demo.")
    result = fn(prompt, images)
    if not isinstance(result, dict):
        raise AIError("The AI returned something unexpected. Try again.")
    return result


def run_lens(prompt):
    r = run_json(prompt)
    if not r.get("headline") or not isinstance(r.get("keyPoints"), list):
        raise AIError("The tailored version came back incomplete. Try again.")
    clean = {"headline": str(r.get("headline"))[:300], "summary": str(r.get("summary") or "")[:1200],
             "metrics": [], "keyPoints": [str(x)[:400] for x in r.get("keyPoints", [])][:6],
             "decisions": [], "watchOuts": [str(x)[:400] for x in (r.get("watchOuts") or [])][:4]}
    for m in (r.get("metrics") or [])[:4]:
        if isinstance(m, dict):
            clean["metrics"].append({k: str(m.get(k) or "")[:120] for k in ("label", "value", "note")})
    for d in (r.get("decisions") or [])[:5]:
        if isinstance(d, dict):
            clean["decisions"].append({"decision": str(d.get("decision") or "")[:300], "why": str(d.get("why") or "")[:400]})
        elif d:
            clean["decisions"].append({"decision": str(d)[:300], "why": ""})
    return clean


def run(prompt, images=None):
    result = run_json(prompt, images)
    if not isinstance(result.get("steps"), list) or not result["steps"]:
        raise AIError("The analysis came back incomplete. Try again, or add more detail.")
    return result


def decode_images(items):
    """A list of data URLs -> list of images (max 5, 20 MB in total)."""
    out, total = [], 0
    for u in (items or [])[:5]:
        img = decode_image(u)
        if img:
            total += len(img["data"]) * 3 // 4
            out.append(img)
    if total > 20 * 1024 * 1024:
        raise AIError("Those images are too large together. Use fewer or smaller pages.")
    return out


def decode_image(data_url):
    """'data:image/png;base64,....' -> {'media_type', 'data'} or None."""
    if not data_url:
        return None
    m = re.match(r"^data:(image/(?:png|jpeg|webp|gif));base64,(.+)$", data_url, re.S)
    if not m:
        raise AIError("Unsupported image. Use PNG, JPEG, WEBP or GIF.")
    raw = base64.b64decode(m.group(2), validate=False)
    if len(raw) > 5 * 1024 * 1024:
        raise AIError("That image is over 5 MB. Use a smaller screenshot.")
    return {"media_type": m.group(1), "data": m.group(2)}