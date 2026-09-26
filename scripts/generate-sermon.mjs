// generate-sermon.mjs
//
// Runs on a GitHub Actions schedule (twice a day). Picks the Bible-study
// section that has the fewest sermons so far, asks Claude to draft a new
// bilingual (English/Telugu) sermon for it in the site's exact data shape,
// and inserts it into Supabase with status = "draft" so a human (Manu)
// reviews and releases it before it ever appears live to readers.
//
// Required environment variables (set as GitHub repo secrets):
//   ANTHROPIC_API_KEY     - from https://console.anthropic.com/settings/keys
//   SUPABASE_SERVICE_KEY  - the project's secret/service_role key (server-only, never in the browser)
//
// Optional:
//   ANTHROPIC_MODEL       - defaults to "claude-sonnet-5"

const SUPABASE_URL = "https://xfnpsctsoihlyxzqovum.supabase.co";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY secret.");
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_SERVICE_KEY secret.");
  process.exit(1);
}

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    extra || {}
  );
}

async function sbGet(path) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: sbHeaders() });
  if (!res.ok) {
    throw new Error("Supabase GET " + path + " failed: " + res.status + " " + (await res.text()));
  }
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error("Supabase INSERT into " + table + " failed: " + res.status + " " + (await res.text()));
  }
  return res.json();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ---------------- 1. pick a section ---------------- */

async function pickSection() {
  const sections = await sbGet("sections?select=id,slug,position,audience,title_en");
  const sermons = await sbGet("sermons?select=id,section_id,sequence");

  const counts = {};
  const maxSeq = {};
  for (const s of sermons) {
    counts[s.section_id] = (counts[s.section_id] || 0) + 1;
    maxSeq[s.section_id] = Math.max(maxSeq[s.section_id] || 0, s.sequence || 0);
  }

  sections.sort((a, b) => {
    const ca = counts[a.id] || 0;
    const cb = counts[b.id] || 0;
    if (ca !== cb) return ca - cb;
    return a.position - b.position;
  });

  const chosen = sections[0];
  const nextSequence = (maxSeq[chosen.id] || 0) + 1;
  const existingIds = new Set(sermons.map((s) => s.id));

  return { chosen, nextSequence, existingIds };
}

/* ---------------- 2. draft the sermon via Claude ---------------- */

const DRAFT_TOOL = {
  name: "draft_sermon",
  description: "Submit a complete bilingual (English + Telugu) Bible sermon draft in three divisions.",
  input_schema: {
    type: "object",
    properties: {
      title_en: { type: "string", description: "A warm, specific sermon title in English." },
      title_te: { type: "string", description: "The same title rendered in Telugu (a working preaching translation)." },
      subtitle_en: { type: "string", description: "A one-line subtitle in English." },
      subtitle_te: { type: "string", description: "The subtitle in Telugu." },
      key_ref: { type: "string", description: "One primary Bible reference anchoring the sermon, e.g. 'Romans 8:28' or 'John 15:5'." },
      key_text_en: { type: "string", description: "The exact King James Version wording of key_ref, word for word." },
      key_text_te: { type: "string", description: "A Telugu rendering of key_ref, for preaching." },
      thesis_en: {
        type: "string",
        description:
          "DIVISION 1 — a brief explanation of the chosen topic, 2 to 4 sentences, written as the pastor introducing it to the congregation before the sermon proper begins.",
      },
      thesis_te: { type: "string", description: "Division 1, in Telugu." },
      movement_head_en: { type: "string", description: "A short heading for the point-by-point teaching section (Division 2), e.g. 'Three ways grace meets us here'." },
      movement_head_te: { type: "string", description: "That heading in Telugu." },
      points: {
        type: "array",
        minItems: 4,
        maxItems: 7,
        description:
          "DIVISION 2 — the sermon itself, drafted point-wise / step by step, as the pastor preaching to the congregation. 4 to 7 points, each a clear step in the teaching, building in order.",
        items: {
          type: "object",
          properties: {
            text_en: { type: "string", description: "The point itself, one or two sentences, in English." },
            text_te: { type: "string", description: "The same point in Telugu." },
            explain_en: { type: "array", items: { type: "string" }, description: "1-3 short paragraphs unpacking the point, in English." },
            explain_te: { type: "array", items: { type: "string" }, description: "The same explanation paragraphs in Telugu." },
            refs: { type: "array", items: { type: "string" }, description: "Bible references supporting this point." },
          },
          required: ["text_en", "text_te", "explain_en", "explain_te", "refs"],
        },
      },
      summary: {
        type: "array",
        minItems: 4,
        maxItems: 7,
        description: "DIVISION 3 — Notes: the sermon in points, as usual. A short recap list, one line per point, with supporting references.",
        items: {
          type: "object",
          properties: {
            point_en: { type: "string" },
            point_te: { type: "string" },
            refs: { type: "array", items: { type: "string" } },
          },
          required: ["point_en", "point_te", "refs"],
        },
      },
      minutes: { type: "integer", description: "Estimated reading/preaching time in minutes, typically 6 to 12." },
    },
    required: [
      "title_en", "title_te", "subtitle_en", "subtitle_te",
      "key_ref", "key_text_en", "key_text_te",
      "thesis_en", "thesis_te",
      "movement_head_en", "movement_head_te",
      "points", "summary", "minutes",
    ],
  },
};

async function draftSermon(section) {
  const system =
    "You are an experienced pastor preparing a new sermon for a bilingual (English and Telugu) sermon-reading library used by a church congregation. " +
    "You choose the specific topic yourself, within the general theme given to you, and you draft the sermon as if you are the pastor explaining it to the congregation. " +
    "The sermon MUST have exactly three divisions, matching the site's structure: " +
    "(1) a brief explanation of the chosen topic (the thesis fields), " +
    "(2) a separate section where the sermon itself is drafted point-wise, step by step (the points array), " +
    "(3) a notes section that recaps the sermon in points, as usual (the summary array). " +
    "Write in a warm, clear, pastoral voice grounded in Scripture. Quote the King James Version exactly for key_text_en. " +
    "The Telugu text is a working preaching translation, not a formal published one — write it naturally and clearly for a Telugu-speaking congregation. " +
    "Use the draft_sermon tool to submit your work; do not write prose outside the tool call.";

  const user =
    "General theme / section for this sermon: \"" + section.chosen.title_en + "\" (audience: " + section.chosen.audience + "). " +
    "Choose your own specific sermon topic within this theme. Draft one complete new sermon now.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: system,
      messages: [{ role: "user", content: user }],
      tools: [DRAFT_TOOL],
      tool_choice: { type: "tool", name: "draft_sermon" },
    }),
  });

  if (!res.ok) {
    throw new Error("Anthropic API request failed: " + res.status + " " + (await res.text()));
  }
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "draft_sermon");
  if (!toolUse) {
    throw new Error("Claude did not return a draft_sermon tool call: " + JSON.stringify(data));
  }
  return toolUse.input;
}

/* ---------------- 3. shape + insert ---------------- */

function buildRow(section, seq, existingIds, draft) {
  let id = slugify(draft.title_en) || "sermon-" + Date.now();
  let candidate = id;
  let n = 2;
  while (existingIds.has(candidate)) {
    candidate = id + "-" + n;
    n++;
  }
  id = candidate;

  const movementEn = {
    n: "I",
    head: draft.movement_head_en,
    refs: dedupeRefs(draft.points.flatMap((p) => p.refs || [])),
    paras: [],
    points: draft.points.map((p) => ({
      text: p.text_en,
      explain: p.explain_en || [],
      refs: p.refs || [],
    })),
  };
  const movementTe = {
    n: "I",
    head: draft.movement_head_te,
    refs: movementEn.refs,
    paras: [],
    points: draft.points.map((p) => ({
      text: p.text_te,
      explain: p.explain_te || [],
      refs: p.refs || [],
    })),
  };

  const bodyEn = {
    keyText: draft.key_text_en,
    movements: [movementEn],
    summary: draft.summary.map((s) => ({ point: s.point_en, refs: s.refs || [] })),
  };
  const bodyTe = {
    keyText: draft.key_text_te,
    movements: [movementTe],
    summary: draft.summary.map((s) => ({ point: s.point_te, refs: s.refs || [] })),
  };

  return {
    id: id,
    section_id: section.chosen.id,
    sequence: seq,
    title_en: draft.title_en,
    title_te: draft.title_te,
    subtitle_en: draft.subtitle_en,
    subtitle_te: draft.subtitle_te,
    key_ref: draft.key_ref,
    thesis_en: draft.thesis_en,
    thesis_te: draft.thesis_te,
    minutes: draft.minutes,
    audience: section.chosen.audience,
    status: "draft",
    image_url: null,
    body_en: bodyEn,
    body_te: bodyTe,
  };
}

function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

/* ---------------- run ---------------- */

async function main() {
  const section = await pickSection();
  console.log("Chosen section: " + section.chosen.title_en + " (id=" + section.chosen.id + "), next sequence=" + section.nextSequence);

  const draft = await draftSermon(section);
  console.log("Drafted: " + draft.title_en);

  const row = buildRow(section, section.nextSequence, section.existingIds, draft);
  const inserted = await sbInsert("sermons", row);

  console.log("Inserted draft sermon id=" + row.id + " into section '" + section.chosen.title_en + "' with status=draft.");
  console.log(JSON.stringify(inserted[0] || inserted, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// generate-sermon.mjs
//
// Runs on a GitHub Actions schedule (twice a day). Picks the Bible-study
// section that has the fewest sermons so far, asks Claude to draft a new
// bilingual (English/Telugu) sermon for it in the site's exact data shape,
// and inserts it into Supabase with status = "draft" so a human (Manu)
// reviews and releases it before it ever appears live to readers.
//
// Required environment variables (set as GitHub repo secrets):
//   ANTHROPIC_API_KEY     - from https://console.anthropic.com/settings/keys
//   SUPABASE_SERVICE_KEY  - the project's secret/service_role key (server-only, never in the browser)
//
// Optional:
//   ANTHROPIC_MODEL       - defaults to "claude-sonnet-4-5"

const SUPABASE_URL = "https://xfnpsctsoihlyxzqovum.supabase.co";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY secret.");
  process.exit(1);
}
if (!SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_SERVICE_KEY secret.");
  process.exit(1);
}

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    extra || {}
  );
}

async function sbGet(path) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: sbHeaders() });
  if (!res.ok) {
    throw new Error("Supabase GET " + path + " failed: " + res.status + " " + (await res.text()));
  }
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error("Supabase INSERT into " + table + " failed: " + res.status + " " + (await res.text()));
  }
  return res.json();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ---------------- 1. pick a section ---------------- */

async function pickSection() {
  const sections = await sbGet("sections?select=id,slug,position,audience,title_en");
  const sermons = await sbGet("sermons?select=id,section_id,sequence");

  const counts = {};
  const maxSeq = {};
  for (const s of sermons) {
    counts[s.section_id] = (counts[s.section_id] || 0) + 1;
    maxSeq[s.section_id] = Math.max(maxSeq[s.section_id] || 0, s.sequence || 0);
  }

  sections.sort((a, b) => {
    const ca = counts[a.id] || 0;
    const cb = counts[b.id] || 0;
    if (ca !== cb) return ca - cb;
    return a.position - b.position;
  });

  const chosen = sections[0];
  const nextSequence = (maxSeq[chosen.id] || 0) + 1;
  const existingIds = new Set(sermons.map((s) => s.id));

  return { chosen, nextSequence, existingIds };
}

/* ---------------- 2. draft the sermon via Claude ---------------- */

const DRAFT_TOOL = {
  name: "draft_sermon",
  description: "Submit a complete bilingual (English + Telugu) Bible sermon draft in three divisions.",
  input_schema: {
    type: "object",
    properties: {
      title_en: { type: "string", description: "A warm, specific sermon title in English." },
      title_te: { type: "string", description: "The same title rendered in Telugu (a working preaching translation)." },
      subtitle_en: { type: "string", description: "A one-line subtitle in English." },
      subtitle_te: { type: "string", description: "The subtitle in Telugu." },
      key_ref: { type: "string", description: "One primary Bible reference anchoring the sermon, e.g. 'Romans 8:28' or 'John 15:5'." },
      key_text_en: { type: "string", description: "The exact King James Version wording of key_ref, word for word." },
      key_text_te: { type: "string", description: "A Telugu rendering of key_ref, for preaching." },
      thesis_en: {
        type: "string",
        description:
          "DIVISION 1 — a brief explanation of the chosen topic, 2 to 4 sentences, written as the pastor introducing it to the congregation before the sermon proper begins.",
      },
      thesis_te: { type: "string", description: "Division 1, in Telugu." },
      movement_head_en: { type: "string", description: "A short heading for the point-by-point teaching section (Division 2), e.g. 'Three ways grace meets us here'." },
      movement_head_te: { type: "string", description: "That heading in Telugu." },
      points: {
        type: "array",
        minItems: 4,
        maxItems: 7,
        description:
          "DIVISION 2 — the sermon itself, drafted point-wise / step by step, as the pastor preaching to the congregation. 4 to 7 points, each a clear step in the teaching, building in order.",
        items: {
          type: "object",
          properties: {
            text_en: { type: "string", description: "The point itself, one or two sentences, in English." },
            text_te: { type: "string", description: "The same point in Telugu." },
            explain_en: { type: "array", items: { type: "string" }, description: "1-3 short paragraphs unpacking the point, in English." },
            explain_te: { type: "array", items: { type: "string" }, description: "The same explanation paragraphs in Telugu." },
            refs: { type: "array", items: { type: "string" }, description: "Bible references supporting this point." },
          },
          required: ["text_en", "text_te", "explain_en", "explain_te", "refs"],
        },
      },
      summary: {
        type: "array",
        minItems: 4,
        maxItems: 7,
        description: "DIVISION 3 — Notes: the sermon in points, as usual. A short recap list, one line per point, with supporting references.",
        items: {
          type: "object",
          properties: {
            point_en: { type: "string" },
            point_te: { type: "string" },
            refs: { type: "array", items: { type: "string" } },
          },
          required: ["point_en", "point_te", "refs"],
        },
      },
      minutes: { type: "integer", description: "Estimated reading/preaching time in minutes, typically 6 to 12." },
    },
    required: [
      "title_en", "title_te", "subtitle_en", "subtitle_te",
      "key_ref", "key_text_en", "key_text_te",
      "thesis_en", "thesis_te",
      "movement_head_en", "movement_head_te",
      "points", "summary", "minutes",
    ],
  },
};

async function draftSermon(section) {
  const system =
    "You are an experienced pastor preparing a new sermon for a bilingual (English and Telugu) sermon-reading library used by a church congregation. " +
    "You choose the specific topic yourself, within the general theme given to you, and you draft the sermon as if you are the pastor explaining it to the congregation. " +
    "The sermon MUST have exactly three divisions, matching the site's structure: " +
    "(1) a brief explanation of the chosen topic (the thesis fields), " +
    "(2) a separate section where the sermon itself is drafted point-wise, step by step (the points array), " +
    "(3) a notes section that recaps the sermon in points, as usual (the summary array). " +
    "Write in a warm, clear, pastoral voice grounded in Scripture. Quote the King James Version exactly for key_text_en. " +
    "The Telugu text is a working preaching translation, not a formal published one — write it naturally and clearly for a Telugu-speaking congregation. " +
    "Use the draft_sermon tool to submit your work; do not write prose outside the tool call.";

  const user =
    "General theme / section for this sermon: \"" + section.chosen.title_en + "\" (audience: " + section.chosen.audience + "). " +
    "Choose your own specific sermon topic within this theme. Draft one complete new sermon now.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: system,
      messages: [{ role: "user", content: user }],
      tools: [DRAFT_TOOL],
      tool_choice: { type: "tool", name: "draft_sermon" },
    }),
  });

  if (!res.ok) {
    throw new Error("Anthropic API request failed: " + res.status + " " + (await res.text()));
  }
  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "draft_sermon");
  if (!toolUse) {
    throw new Error("Claude did not return a draft_sermon tool call: " + JSON.stringify(data));
  }
  return toolUse.input;
}

/* ---------------- 3. shape + insert ---------------- */

function buildRow(section, seq, existingIds, draft) {
  let id = slugify(draft.title_en) || "sermon-" + Date.now();
  let candidate = id;
  let n = 2;
  while (existingIds.has(candidate)) {
    candidate = id + "-" + n;
    n++;
  }
  id = candidate;

  const movementEn = {
    n: "I",
    head: draft.movement_head_en,
    refs: dedupeRefs(draft.points.flatMap((p) => p.refs || [])),
    paras: [],
    points: draft.points.map((p) => ({
      text: p.text_en,
      explain: p.explain_en || [],
      refs: p.refs || [],
    })),
  };
  const movementTe = {
    n: "I",
    head: draft.movement_head_te,
    refs: movementEn.refs,
    paras: [],
    points: draft.points.map((p) => ({
      text: p.text_te,
      explain: p.explain_te || [],
      refs: p.refs || [],
    })),
  };

  const bodyEn = {
    keyText: draft.key_text_en,
    movements: [movementEn],
    summary: draft.summary.map((s) => ({ point: s.point_en, refs: s.refs || [] })),
  };
  const bodyTe = {
    keyText: draft.key_text_te,
    movements: [movementTe],
    summary: draft.summary.map((s) => ({ point: s.point_te, refs: s.refs || [] })),
  };

  return {
    id: id,
    section_id: section.chosen.id,
    sequence: seq,
    title_en: draft.title_en,
    title_te: draft.title_te,
    subtitle_en: draft.subtitle_en,
    subtitle_te: draft.subtitle_te,
    key_ref: draft.key_ref,
    thesis_en: draft.thesis_en,
    thesis_te: draft.thesis_te,
    minutes: draft.minutes,
    audience: section.chosen.audience,
    status: "draft",
    image_url: null,
    body_en: bodyEn,
    body_te: bodyTe,
  };
}

function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

/* ---------------- run ---------------- */

async function main() {
  const section = await pickSection();
  console.log("Chosen section: " + section.chosen.title_en + " (id=" + section.chosen.id + "), next sequence=" + section.nextSequence);

  const draft = await draftSermon(section);
  console.log("Drafted: " + draft.title_en);

  const row = buildRow(section, section.nextSequence, section.existingIds, draft);
  const inserted = await sbInsert("sermons", row);

  console.log("Inserted draft sermon id=" + row.id + " into section '" + section.chosen.title_en + "' with status=draft.");
  console.log(JSON.stringify(inserted[0] || inserted, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
