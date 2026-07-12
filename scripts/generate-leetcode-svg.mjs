#!/usr/bin/env node
/**
 * Generates leetcode-stats.svg for a GitHub profile README.
 * Zero dependencies — requires Node 18+ (built-in fetch).
 *
 * Usage: node scripts/generate-leetcode-svg.mjs [output-path]
 */

import { writeFileSync } from "node:fs";

const USERNAME = "LilacPlanet";
const SUBMISSION_LIMIT = 20;
const SHOWN_SUBMISSIONS = 5;
const OUTPUT_PATH = process.argv[2] ?? "leetcode-stats.svg";

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql/";

// ---- theme (matches lilacplanet.dev) ----------------------------------------
const theme = {
  card: "#1F1838",
  cardBorder: "#322851",
  accent: "#c4b5fd", // violet-300
  divider: "#2b2148",
  white: "#ffffff",
  violet: "#c4b5fd",
  violetDim: "rgba(196,181,253,0.6)",
  green: "#86efac", // green-300
  amber: "#fcd34d", // amber-300
  rose: "#fda4af", // rose-300
  activity: ["#211a3c", "#453465", "#6b539b", "#9a7fd1", "#c4b5fd"],
};

const sans = "'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif";
const mono = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

// ---- LeetCode queries (same as the website) ---------------------------------
const SUBMIT_STATS_QUERY = `
  query userSessionProgress($username: String!) {
    matchedUser(username: $username) {
      submitStats: submitStatsGlobal {
        acSubmissionNum { difficulty count }
      }
    }
  }
`;

const CALENDAR_QUERY = `
  query userProfileCalendar($username: String!, $year: Int) {
    matchedUser(username: $username) {
      userCalendar(year: $year) { activeYears submissionCalendar }
    }
  }
`;

const RECENT_SUBMISSIONS_QUERY = `
  query getRecentSubmissionList($username: String!, $limit: Int) {
    recentSubmissionList(username: $username, limit: $limit) {
      title titleSlug timestamp statusDisplay lang
    }
  }
`;

async function runLeetCodeQuery(query, variables) {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: "https://leetcode.com/",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) throw new Error(`LeetCode returned ${response.status}.`);

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  if (!payload.data) throw new Error("LeetCode returned no data.");
  return payload.data;
}

// ---- data shaping (same logic as the website) --------------------------------
function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, amount) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function parseSubmissionCalendar(calendar) {
  if (!calendar) return new Map();
  try {
    const parsed = JSON.parse(calendar);
    const dates = new Map();
    for (const [unixTimestamp, count] of Object.entries(parsed)) {
      const date = toDateKey(new Date(Number(unixTimestamp) * 1000));
      dates.set(date, (dates.get(date) ?? 0) + count);
    }
    return dates;
  } catch {
    return new Map();
  }
}

function calculateStreaks(activityDates) {
  if (activityDates.length === 0) return { currentStreak: 0, bestStreak: 0 };

  const sortedDates = [...new Set(activityDates)].sort();
  let bestStreak = 1;
  let runningStreak = 1;

  for (let i = 1; i < sortedDates.length; i += 1) {
    const diff =
      (new Date(`${sortedDates[i]}T00:00:00Z`) -
        new Date(`${sortedDates[i - 1]}T00:00:00Z`)) /
      86_400_000;
    if (diff === 1) {
      runningStreak += 1;
      bestStreak = Math.max(bestStreak, runningStreak);
    } else {
      runningStreak = 1;
    }
  }

  const activitySet = new Set(sortedDates);
  const today = new Date();
  const latestDate = sortedDates.at(-1);

  if (
    latestDate !== toDateKey(today) &&
    latestDate !== toDateKey(addUtcDays(today, -1))
  ) {
    return { currentStreak: 0, bestStreak };
  }

  let currentStreak = 0;
  let cursor = new Date(`${latestDate}T00:00:00Z`);
  while (activitySet.has(toDateKey(cursor))) {
    currentStreak += 1;
    cursor = addUtcDays(cursor, -1);
  }

  return { currentStreak, bestStreak };
}

function getLastThirtyDays(calendar) {
  const today = new Date();
  return Array.from({ length: 30 }, (_, index) => {
    const dateKey = toDateKey(addUtcDays(today, index - 29));
    return { date: dateKey, count: calendar.get(dateKey) ?? 0 };
  });
}

function dedupeSubmissions(submissions) {
  const byProblemAndDay = new Map();
  for (const submission of submissions) {
    const day = toDateKey(new Date(submission.timestamp * 1000));
    const key = `${submission.titleSlug}:${day}`;
    const existing = byProblemAndDay.get(key);
    if (
      !existing ||
      (submission.status === "Accepted" && existing.status !== "Accepted")
    ) {
      byProblemAndDay.set(key, submission);
    }
  }
  return [...byProblemAndDay.values()].sort((a, b) => b.timestamp - a.timestamp);
}

async function fetchStats(username) {
  const currentYear = new Date().getUTCFullYear();

  const [submitStatsData, recentSubmissionsData, calendarData] =
    await Promise.all([
      runLeetCodeQuery(SUBMIT_STATS_QUERY, { username }),
      runLeetCodeQuery(RECENT_SUBMISSIONS_QUERY, {
        username,
        limit: SUBMISSION_LIMIT,
      }),
      runLeetCodeQuery(CALENDAR_QUERY, { username, year: currentYear }),
    ]);

  if (!submitStatsData.matchedUser || !calendarData.matchedUser) {
    throw new Error(`LeetCode user ${username} was not found.`);
  }

  const currentCalendar = calendarData.matchedUser.userCalendar;
  const otherYears = [
    ...new Set(currentCalendar?.activeYears ?? [currentYear]),
  ].filter((year) => year !== currentYear);

  const otherCalendars = await Promise.all(
    otherYears.map((year) =>
      runLeetCodeQuery(CALENDAR_QUERY, { username, year }),
    ),
  );

  const merged = new Map();
  for (const calendar of [
    parseSubmissionCalendar(currentCalendar?.submissionCalendar),
    ...otherCalendars.map((r) =>
      parseSubmissionCalendar(r.matchedUser?.userCalendar?.submissionCalendar),
    ),
  ]) {
    for (const [date, count] of calendar) {
      merged.set(date, (merged.get(date) ?? 0) + count);
    }
  }

  const activityDates = [...merged.entries()]
    .filter(([, count]) => count > 0)
    .map(([date]) => date);

  const solved = { Easy: 0, Medium: 0, Hard: 0 };
  for (const stat of submitStatsData.matchedUser.submitStats.acSubmissionNum) {
    if (stat.difficulty !== "All") solved[stat.difficulty] = stat.count;
  }

  return {
    solved,
    activity: getLastThirtyDays(merged),
    ...calculateStreaks(activityDates),
    recentSubmissions: dedupeSubmissions(
      recentSubmissionsData.recentSubmissionList.map((s) => ({
        title: s.title,
        titleSlug: s.titleSlug,
        timestamp: Number(s.timestamp),
        status: s.statusDisplay,
        language: s.lang,
      })),
    ).slice(0, SHOWN_SUBMISSIONS),
  };
}

// ---- SVG rendering -----------------------------------------------------------
function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getActivityLevel(count, maximum) {
  if (count === 0 || maximum === 0) return 0;
  const ratio = count / maximum;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

function renderSvg(stats) {
  const width = 780;
  const height = 500;
  const parts = [];

  parts.push(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LeetCode stats for ${USERNAME}">`,
    // card with left accent (border-l-4 look)
    `<rect width="${width}" height="${height}" rx="16" fill="${theme.accent}"/>`,
    `<rect x="4" y="0" width="${width - 4}" height="${height}" rx="16" fill="${theme.card}" stroke="${theme.cardBorder}"/>`,
    `<rect x="4" y="0" width="16" height="${height}" fill="${theme.card}" opacity="0"/>`,
  );

  // header
  const updated = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date());

  parts.push(
    `<text x="32" y="42" font-family="${sans}" font-size="17" font-weight="700" fill="${theme.white}">LeetCode stats</text>`,
    `<text x="32" y="63" font-family="${mono}" font-size="12" fill="${theme.violet}">updated ${updated}</text>`,
    `<text x="748" y="42" text-anchor="end" font-family="${mono}" font-size="13" fill="${theme.violet}">streak <tspan font-weight="700" fill="${theme.white}">${stats.currentStreak}</tspan>  ·  best <tspan font-weight="700" fill="${theme.white}">${stats.bestStreak}</tspan></text>`,
    `<line x1="32" y1="84" x2="748" y2="84" stroke="${theme.divider}"/>`,
  );

  const label = (x, y, text) =>
    `<text x="${x}" y="${y}" font-family="${mono}" font-size="11" font-weight="600" letter-spacing="1.5" fill="${theme.violet}">${text}</text>`;

  // ---- left column: heatmap ----
  parts.push(label(32, 118, "LAST 30 DAYS"));

  const maximum = Math.max(...stats.activity.map((d) => d.count), 0);
  const cell = 40;
  const gap = 6;
  stats.activity.forEach((day, index) => {
    const col = index % 6;
    const row = Math.floor(index / 6);
    const x = 32 + col * (cell + gap);
    const y = 132 + row * (cell + gap);
    const fill = theme.activity[getActivityLevel(day.count, maximum)];
    parts.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="8" fill="${fill}"/>`);
  });

  // ---- left column: solved bars ----
  parts.push(label(32, 388, "SOLVED"));

  const difficultyColors = {
    Easy: theme.green,
    Medium: theme.amber,
    Hard: theme.rose,
  };
  const maxSolved = Math.max(...Object.values(stats.solved), 1);
  const barWidth = 342;

  Object.entries(stats.solved).forEach(([difficulty, count], index) => {
    const textY = 410 + index * 32;
    const barY = textY + 7;
    const fillWidth =
      count === 0 ? 0 : Math.max((count / maxSolved) * barWidth, barWidth * 0.05);

    parts.push(
      `<text x="32" y="${textY}" font-family="${sans}" font-size="13" font-weight="600" fill="${difficultyColors[difficulty]}">${difficulty}</text>`,
      `<text x="${32 + barWidth}" y="${textY}" text-anchor="end" font-family="${sans}" font-size="13" font-weight="700" fill="${theme.white}">${count}</text>`,
      `<rect x="32" y="${barY}" width="${barWidth}" height="4" rx="2" fill="${theme.divider}"/>`,
      fillWidth > 0
        ? `<rect x="32" y="${barY}" width="${fillWidth.toFixed(1)}" height="4" rx="2" fill="${difficultyColors[difficulty]}"/>`
        : "",
    );
  });

  // ---- right column: recent submissions ----
  const colX = 406;
  parts.push(label(colX, 118, "RECENT SUBMISSIONS"));

  stats.recentSubmissions.forEach((submission, index) => {
    const boxY = 132 + index * 68;
    const accepted = submission.status === "Accepted";
    const statusColor = accepted ? theme.green : theme.amber;
    const icon = accepted ? "✓" : "✗";

    parts.push(
      `<rect x="${colX}" y="${boxY}" width="342" height="58" rx="12" fill="none" stroke="${theme.divider}"/>`,
      `<text x="${colX + 16}" y="${boxY + 25}" font-family="${sans}" font-size="14" font-weight="700" fill="${theme.white}">${escapeXml(truncate(submission.title, 36))}</text>`,
      `<text x="${colX + 16}" y="${boxY + 45}" font-family="${sans}" font-size="11" font-weight="600" fill="${statusColor}">${icon} ${escapeXml(submission.status)}<tspan dx="10" font-family="${mono}" font-weight="400" fill="${theme.violetDim}">${escapeXml(submission.language)} · ${formatDate(submission.timestamp)}</tspan></text>`,
    );
  });

  parts.push("</svg>");
  return parts.filter(Boolean).join("\n");
}

// ---- main --------------------------------------------------------------------
const stats = await fetchStats(USERNAME);
writeFileSync(OUTPUT_PATH, renderSvg(stats));
console.log(`Wrote ${OUTPUT_PATH}`);
