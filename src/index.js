// ─────────────────────────────────────────────────────────────
//  OVERWATCH — Cox Roofing & Restoration
//  Daily Performance Intelligence System
//  Runs nightly via GitHub Actions, delivers 8am report
// ─────────────────────────────────────────────────────────────

const https = require('https');
const fs = require('fs');
const path = require('path');


// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  jobnimbus: {
    apiKey: process.env.JOBNIMBUS_API_KEY,
    baseUrl: 'app.jobnimbus.com',
    basePath: '/api1'
  },
  salesRabbit: {
    apiKey: process.env.SALESRABBIT_API_KEY,
    baseUrl: 'api.salesrabbit.com'
  },
};

// ── SCORING WEIGHTS ────────────────────────────────────────────
const WEIGHTS = {
  jobnimbus: {
    contractSigned: 20,
    estimateSubmitted: 8,
    appointmentSelfGen: 5,
    appointmentCompanyLead: 2,
    leadCreated: 3,
    stageMove: 1,        // max 5
    noteCap: 5,          // max notes per job per day that count
    noteValue: 0.5,
    taskValue: 0.5,
    pipelineViolationPenalty: -5,
    platformCeiling: 40
  },
  salesRabbit: {
    pinAtLocation: 0.15,       // max 15 pts (100 pins)
    pinNearLocation: 0.06,     // 40% of pin value
    pinNotAtLocation: 0,       // 0 pts + flag
    outcomeAppointment: 3,     // bonus per confirmed AT pin
    outcomeInterested: 1,      // bonus
    outcomeNotHome: 0.25,      // up to 50 pins
    doorTargetFull: 100,
    platformCeiling: 25
  },
  companyCam: {
    projectCreated: 8,
    checklistCompleted: 4,
    reportGenerated: 2,
    sharedLink: 1,
    photoValue: 0.1,           // capped at 20 photos/project/day
    photoCapPerProject: 20,
    zeroPhosPenalty: -5,       // if visited job with 0 photos
    platformCeiling: 15
  },
  autoEliteThreshold: 2,       // contracts needed for auto-elite
  autoEliteScore: 95,
  targetScore: 80              // B grade daily target
};

// ── GPS DISTANCE HELPER ────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getGPSStatus(pinLat, pinLon, repLat, repLon) {
  if (!repLat || !repLon) return 'NOT_AT_LOCATION';
  const dist = haversineDistance(pinLat, pinLon, repLat, repLon);
  if (dist <= 0.019) return 'AT_LOCATION';       // ~100 feet
  if (dist <= 0.25)  return 'NEAR_LOCATION';
  return 'NOT_AT_LOCATION';
}

// ── HTTP HELPER ────────────────────────────────────────────────
function apiGet(host, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname: host, path, method: 'GET', headers };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── YESTERDAY DATE RANGE ───────────────────────────────────────
function getYesterdayRange() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const end = new Date(yesterday);
  end.setHours(23, 59, 59, 999);
  return {
    start: Math.floor(yesterday.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
    label: yesterday.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
  };
}

// ── JOBNIMBUS DATA FETCH ───────────────────────────────────────
async function fetchJobNimbusData(dateRange) {
  console.log('Fetching JobNimbus data...');
  const headers = {
    'Authorization': `Bearer ${CONFIG.jobnimbus.apiKey}`,
    'Content-Type': 'application/json'
  };
  const activitiesRes = await apiGet(
    CONFIG.jobnimbus.baseUrl,
    `${CONFIG.jobnimbus.basePath}/activities?limit=500`,
    headers
  );

  // Fetch jobs for pipeline check
  const jobsRes = await apiGet(
    CONFIG.jobnimbus.baseUrl,
    `${CONFIG.jobnimbus.basePath}/jobs?limit=500`,
    headers
  );

  // Fetch contacts created yesterday
  const contactsRes = await apiGet(
    CONFIG.jobnimbus.baseUrl,
    `${CONFIG.jobnimbus.basePath}/contacts?date_start=${dateRange.start}&date_end=${dateRange.end}&limit=500`,
    headers
  );

  return {
    activities: activitiesRes.status === 200 ? activitiesRes.body.results || [] : [],
    jobs: jobsRes.status === 200 ? jobsRes.body.results || [] : [],
    contacts: contactsRes.status === 200 ? contactsRes.body.results || [] : [],
    raw: { activitiesStatus: activitiesRes.status, jobsStatus: jobsRes.status }
  };
}

// ── SALES RABBIT DATA FETCH ────────────────────────────────────
async function fetchSalesRabbitData(dateRange) {
  console.log('Fetching Sales Rabbit data...');
  const headers = {
    'Authorization': `Bearer ${CONFIG.salesRabbit.apiKey}`,
    'Content-Type': 'application/json'
  };

  const leadsRes = await apiGet(
    CONFIG.salesRabbit.baseUrl,
    `/leads?dateFrom=${new Date(dateRange.start*1000).toISOString()}&dateTo=${new Date(dateRange.end*1000).toISOString()}&limit=500`,
    headers
  );

  const usersRes = await apiGet(
    CONFIG.salesRabbit.baseUrl,
    `/users?limit=200`,
    headers
  );

  return {
    leads: leadsRes.status === 200 ? leadsRes.body.data || leadsRes.body.results || [] : [],
    users: usersRes.status === 200 ? usersRes.body.data || usersRes.body.results || [] : [],
    raw: { leadsStatus: leadsRes.status, usersStatus: usersRes.status }
  };
}

// ── SCORE JOBNIMBUS ────────────────────────────────────────────
function scoreJobNimbus(repActivities, allJobs, repId, dateRange) {
  let pts = 0;
  let contracts = 0;
  let estimates = 0;
  let appointments = 0;
  let leads = 0;
  let stageMoves = 0;
  const notesPerJob = {};
  let tasks = 0;
  const flags = [];
  const detail = [];

  // Business hours window (72hrs in seconds = 259200)
  const BIZ_HOURS_72 = 72 * 3600;

  for (const act of repActivities) {
    const type = (act.type || act.activity_type || '').toLowerCase();
    const note = act.note || act.description || '';

    if (type.includes('contract') || type.includes('won') || note.toLowerCase().includes('contract signed')) {
      contracts++;
      pts += WEIGHTS.jobnimbus.contractSigned;
      detail.push({ label: 'Contract Signed', value: `+${WEIGHTS.jobnimbus.contractSigned} pts`, good: true });
    } else if (type.includes('estimate') || type.includes('proposal')) {
      estimates++;
      pts += WEIGHTS.jobnimbus.estimateSubmitted;
      detail.push({ label: 'Estimate Submitted', value: `+${WEIGHTS.jobnimbus.estimateSubmitted} pts`, good: true });
    } else if (type.includes('appointment') || type.includes('scheduled')) {
      appointments++;
      const isSelfGen = !note.toLowerCase().includes('company') && !note.toLowerCase().includes('provided');
      const apptPts = isSelfGen ? WEIGHTS.jobnimbus.appointmentSelfGen : WEIGHTS.jobnimbus.appointmentCompanyLead;
      pts += apptPts;
      detail.push({ label: `Appointment Set (${isSelfGen ? 'Self-Gen' : 'Company Lead'})`, value: `+${apptPts} pts`, good: true });
    } else if (type.includes('lead') || type.includes('contact')) {
      leads++;
      pts += WEIGHTS.jobnimbus.leadCreated;
    } else if (type.includes('stage') || type.includes('status')) {
      if (stageMoves < 5) { stageMoves++; pts += WEIGHTS.jobnimbus.stageMove; }
    } else if (type.includes('note') || type.includes('comment')) {
      const jobId = act.job_id || act.related_id || 'general';
      notesPerJob[jobId] = (notesPerJob[jobId] || 0) + 1;
      if (notesPerJob[jobId] <= WEIGHTS.jobnimbus.noteCap) {
        pts += WEIGHTS.jobnimbus.noteValue;
      }
    } else if (type.includes('task')) {
      if (tasks < 4) { tasks++; pts += WEIGHTS.jobnimbus.taskValue; }
    }
  }

  // Pipeline 72-hour violation check
  const repJobs = allJobs.filter(j => j.sales_rep_id === repId || j.assigned_to === repId);
  let pipelineViolations = 0;
  const staleJobs = [];

  for (const job of repJobs) {
    if (!job.last_activity_date && !job.date_updated) continue;
    const lastActivity = job.last_activity_date || job.date_updated;
    const ageSeconds = (dateRange.end) - lastActivity;
    if (ageSeconds > BIZ_HOURS_72) {
      pipelineViolations++;
      pts += WEIGHTS.jobnimbus.pipelineViolationPenalty;
      staleJobs.push({ name: job.name || job.display_name || 'Unnamed Job', hoursStale: Math.floor(ageSeconds / 3600) });
      flags.push({ type: 'pipeline', text: `Job stale ${Math.floor(ageSeconds/3600)}hrs: "${job.name || 'Unnamed'}"`, severity: 'red' });
    }
  }

  // Cap at ceiling
  pts = Math.min(pts, WEIGHTS.jobnimbus.platformCeiling);
  pts = Math.max(pts, 0);

  return { pts, contracts, estimates, appointments, leads, stageMoves, tasks, pipelineViolations, staleJobs, flags, detail };
}

// ── SCORE SALES RABBIT ─────────────────────────────────────────
function scoreSalesRabbit(repLeads, repUser) {
  let pts = 0;
  let atLocation = 0;
  let nearLocation = 0;
  let notAtLocation = 0;
  let appointmentsFromDoor = 0;
  const flags = [];
  const detail = [];

  for (const lead of repLeads) {
    const pinLat = parseFloat(lead.address_latitude || lead.latitude || 0);
    const pinLon = parseFloat(lead.address_longitude || lead.longitude || 0);
    const repLat = parseFloat(lead.gps_latitude || lead.user_latitude || 0);
    const repLon = parseFloat(lead.gps_longitude || lead.user_longitude || 0);

    const gpsStatus = getGPSStatus(pinLat, pinLon, repLat, repLon);
    const outcome = (lead.status_name || lead.lead_status || lead.disposition || '').toLowerCase();

    if (gpsStatus === 'AT_LOCATION') {
      atLocation++;
      pts += WEIGHTS.salesRabbit.pinAtLocation;
      if (outcome.includes('appointment') || outcome.includes('set')) {
        appointmentsFromDoor++;
        pts += WEIGHTS.salesRabbit.outcomeAppointment;
      } else if (outcome.includes('interest')) {
        pts += WEIGHTS.salesRabbit.outcomeInterested;
      } else if (outcome.includes('not home') || outcome.includes('not interested')) {
        pts += WEIGHTS.salesRabbit.outcomeNotHome;
      }
    } else if (gpsStatus === 'NEAR_LOCATION') {
      nearLocation++;
      pts += WEIGHTS.salesRabbit.pinNearLocation;
    } else {
      notAtLocation++;
      flags.push({ type: 'gps', text: `Pin NOT at location: ${lead.address_1 || 'Unknown address'}`, severity: 'red' });
    }
  }

  const totalPins = atLocation + nearLocation + notAtLocation;
  detail.push({ label: 'Doors Knocked (GPS Verified)', value: `${atLocation} confirmed ✓`, good: atLocation >= 80 });
  detail.push({ label: 'Near Location Pins', value: `${nearLocation}`, good: true });
  if (notAtLocation > 0) {
    detail.push({ label: 'NOT At Location Flags', value: `🚫 ${notAtLocation} flagged`, good: false });
  }

  // Flag if 100 doors but zero appointments/estimates
  if (atLocation >= 100 && appointmentsFromDoor === 0) {
    flags.push({ type: 'canvassing', text: '100+ doors knocked with zero appointments set — volume without outcome', severity: 'yellow' });
  }

  pts = Math.min(pts, WEIGHTS.salesRabbit.platformCeiling);
  pts = Math.max(pts, 0);

  return { pts, atLocation, nearLocation, notAtLocation, appointmentsFromDoor, totalPins, flags, detail };
}

// ── SPLIT JOB CREDIT ───────────────────────────────────────────
function resolveSplitCredit(job, allActivities) {
  const salesRepId = job.sales_rep_id;
  const assigneeId = job.assigned_to;
  if (!salesRepId || !assigneeId || salesRepId === assigneeId) return null;

  const jobActivities = allActivities.filter(a => a.job_id === job.jnid || a.related_id === job.jnid);
  const repCount = jobActivities.filter(a => a.created_by === salesRepId).length;
  const assigneeCount = jobActivities.filter(a => a.created_by === assigneeId).length;
  const total = repCount + assigneeCount;
  if (total === 0) return { repPct: 50, assigneePct: 50 };

  return {
    repPct: Math.round((repCount / total) * 100),
    assigneePct: Math.round((assigneeCount / total) * 100),
    repId: salesRepId,
    assigneeId,
    jobName: job.name || job.display_name || 'Unnamed Job'
  };
}

// ── 7-DAY TREND ───────────────────────────────────────────────
function getTrendArrow(todayScore, sevenDayAvg) {
  const diff = todayScore - sevenDayAvg;
  if (diff > 5)  return { arrow: '↑', color: '#2ecc71', label: 'Improving' };
  if (diff < -5) return { arrow: '↓', color: '#e94560', label: 'Declining' };
  return { arrow: '→', color: '#f1c40f', label: 'Flat' };
}

function getGrade(score) {
  if (score >= 90) return { letter: 'A', color: '#2ecc71', tier: 'ELITE', bg: '#1a4a2e' };
  if (score >= 80) return { letter: 'B', color: '#3498db', tier: 'ON TARGET', bg: '#1a3a4a' };
  if (score >= 70) return { letter: 'C', color: '#f1c40f', tier: 'ACCEPTABLE', bg: '#3a3a1a' };
  if (score >= 60) return { letter: 'D', color: '#e67e22', tier: 'BELOW STANDARD', bg: '#3a2a1a' };
  return { letter: 'F', color: '#e94560', tier: 'FAILING', bg: '#3a1a1a' };
}

// ── GENERATE COACH'S NOTE ──────────────────────────────────────
function generateCoachNote(rep, jnScore, srScore, emailScore, ccScore, flags) {
  const total = jnScore.pts + srScore.pts + emailScore + ccScore;
  const grade = getGrade(total);
  const notes = [];

  if (jnScore.contracts >= 2) {
    notes.push(`${rep.name} is delivering elite results — ${jnScore.contracts} contracts today triggers the auto-elite override. This is exactly the performance standard we're building toward.`);
  } else if (jnScore.contracts === 1) {
    notes.push(`${rep.name} closed 1 contract today — solid progress. The next step is stacking a second close on the same day consistently.`);
  } else if (jnScore.estimates > 0) {
    notes.push(`${rep.name} submitted ${jnScore.estimates} estimate(s) today without a close. Focus on the gap between estimate submission and signed contract — what's the follow-up cadence looking like?`);
  }

  if (jnScore.pipelineViolations > 0) {
    notes.push(`${jnScore.pipelineViolations} job(s) went dark beyond 72 hours — pipeline discipline needs attention. Stale jobs cost points and cost revenue.`);
  }

  if (srScore.notAtLocation >= 3) {
    notes.push(`${srScore.notAtLocation} pins were flagged as Not At Location today. This is a pattern that needs a direct conversation.`);
  } else if (srScore.atLocation >= 100 && srScore.appointmentsFromDoor === 0) {
    notes.push(`100+ doors knocked with zero appointments set. Volume is there but conversion is missing — revisit the door pitch.`);
  } else if (srScore.atLocation >= 80) {
    notes.push(`Strong canvassing effort today with ${srScore.atLocation} GPS-verified doors knocked.`);
  }

  if (grade.letter === 'F') {
    notes.push(`This is an F-grade day. Immediate check-in with ${rep.name} is recommended before their next shift.`);
  } else if (grade.letter === 'A') {
    notes.push(`Elite performance today — worth recognizing publicly to reinforce the standard for the rest of the team.`);
  }

  return notes.join(' ') || `${rep.name} had a ${grade.tier} day with a score of ${total}. Review the activity breakdown for coaching opportunities.`;
}

// ── BUILD HTML REPORT ──────────────────────────────────────────
function buildHTMLReport(repResults, dateLabel, splitJobs) {
  const sorted = [...repResults].sort((a, b) => b.totalScore - a.totalScore);
  const teamAvg = Math.round(sorted.reduce((s, r) => s + r.totalScore, 0) / sorted.length);
  const topScore = sorted[0]?.totalScore || 0;
  const eliteCount = sorted.filter(r => r.totalScore >= 90).length;
  const onTargetCount = sorted.filter(r => r.totalScore >= 80 && r.totalScore < 90).length;
  const failCount = sorted.filter(r => r.totalScore < 60).length;

  const allFlags = repResults.flatMap(r => r.flags.map(f => ({ ...f, repName: r.name })));
  const gpsFlags = allFlags.filter(f => f.type === 'gps');
  const pipelineFlags = allFlags.filter(f => f.type === 'pipeline');
  const conductFlags = allFlags.filter(f => f.type === 'conduct');

  // Leaderboard rows
  const lbRows = sorted.map((rep, i) => {
    const grade = getGrade(rep.totalScore);
    const trend = getTrendArrow(rep.totalScore, rep.sevenDayAvg || rep.totalScore);
    const rankClass = i === 0 ? 'gold-row' : i === 1 ? 'silver-row' : i === 2 ? 'bronze-row' : rep.totalScore < 60 ? 'fail-row' : 'normal-row';
    const rankIcon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}`;
    const rankColor = i === 0 ? '#f1c40f' : i === 1 ? '#bdc3c7' : i === 2 ? '#b46421' : rep.totalScore < 60 ? '#e94560' : '#6666aa';

    return `
    <div class="lb-row ${rankClass}">
      <div class="lb-rank" style="color:${rankColor};">${rankIcon}</div>
      <div class="lb-name" style="${rep.totalScore < 60 ? 'color:#e94560;' : ''}">${rep.name}</div>
      <div class="lb-score" style="color:${grade.color};">${rep.totalScore}</div>
      <div class="lb-grade"><span class="grade-badge" style="background:${grade.bg};color:${grade.color};border:1px solid ${grade.color};">${grade.letter}</span></div>
      <div class="lb-trend" style="color:${trend.color};">${trend.arrow}</div>
      <div class="lb-avg" style="${rep.totalScore < 60 ? 'color:#e94560;' : ''}">${rep.sevenDayAvg || '—'} avg</div>
    </div>`;
  }).join('');

  // Rep cards
  const repCards = sorted.map(rep => {
    const grade = getGrade(rep.totalScore);
    const trend = getTrendArrow(rep.totalScore, rep.sevenDayAvg || rep.totalScore);
    const initials = rep.name.split(' ').map(n => n[0]).join('').slice(0, 2);
    const cardClass = rep.totalScore >= 90 ? 'elite' : rep.totalScore >= 80 ? 'on-target' : rep.totalScore < 60 ? 'fail' : '';
    const scoreClass = rep.totalScore >= 90 ? 'score-elite' : rep.totalScore >= 80 ? 'score-ontarget' : rep.totalScore >= 70 ? 'score-ok' : rep.totalScore >= 60 ? 'score-low' : 'score-fail';

    const actItems = [
      { label: 'Contracts Signed', val: rep.jn.contracts, good: rep.jn.contracts > 0 },
      { label: 'Estimates Submitted', val: rep.jn.estimates, good: rep.jn.estimates > 0 },
      { label: 'Appointments Set', val: rep.jn.appointments, good: rep.jn.appointments > 0 },
      { label: 'Doors Knocked (GPS Verified)', val: rep.sr.atLocation, good: rep.sr.atLocation >= 80 },
      { label: 'Not At Location Flags', val: rep.sr.notAtLocation > 0 ? `🚫 ${rep.sr.notAtLocation}` : '✓ None', good: rep.sr.notAtLocation === 0 },
      { label: 'Pipeline Violations (72hr)', val: rep.jn.pipelineViolations > 0 ? `⚠️ ${rep.jn.pipelineViolations} stale jobs` : '✓ All clear', good: rep.jn.pipelineViolations === 0 },
    ].map(item => `
      <div class="act-item">
        <span class="act-label">${item.label}</span>
        <span class="act-val ${item.good ? 'val-good' : 'val-bad'}">${item.val}</span>
      </div>`).join('');

    const repFlagItems = rep.flags.filter(f => f.type !== 'conduct').map(f =>
      `<div class="flag-row"><span class="flag-icon">${f.severity === 'red' ? '🚫' : '⚠️'}</span><span class="flag-text ${f.severity}">${f.text}</span></div>`
    ).join('');

    return `
    <div class="rep-card ${cardClass}">
      <div class="card-header">
        <div class="card-avatar av-blue">${initials}</div>
        <div class="card-info">
          <div class="card-name">${rep.name}</div>
          <div class="card-role">SALES REPRESENTATIVE  •  RANK #${sorted.indexOf(rep)+1}</div>
        </div>
        <div class="card-score-block">
          <div class="card-big-score ${scoreClass}">${rep.totalScore}</div>
          <div class="card-grade-trend">
            <span class="grade-badge" style="background:${grade.bg};color:${grade.color};border:1px solid ${grade.color};padding:3px 8px;border-radius:4px;font-size:12px;font-weight:900;">${grade.letter}</span>
            <span style="color:${trend.color};font-size:18px;">${trend.arrow}</span>
            <span style="font-size:11px;color:#666688;">${rep.sevenDayAvg || '—'} avg</span>
          </div>
        </div>
      </div>
      <div class="platform-bars">
        <div class="plat-bar"><div class="plat-name">JobNimbus</div><div class="plat-pts pts-jn">${rep.jn.pts}</div><div class="plat-max">/ 40</div></div>
        <div class="plat-bar"><div class="plat-name">Sales Rabbit</div><div class="plat-pts pts-sr">${rep.sr.pts}</div><div class="plat-max">/ 25</div></div>
        <div class="plat-bar"><div class="plat-name">CompanyCam</div><div class="plat-pts pts-cc">${rep.ccPts}</div><div class="plat-max">/ 15</div></div>
        <div class="plat-bar"><div class="plat-name">Email</div><div class="plat-pts pts-em">${rep.emailPts}</div><div class="plat-max">/ 20</div></div>
      </div>
      <div class="activity-detail"><h4>Activity Breakdown</h4>${actItems}</div>
      ${repFlagItems ? `<div class="activity-detail">${repFlagItems}</div>` : ''}
      <div class="coach-note">
        <h4>🎯 Coach's Note</h4>
        <p class="coach-text">${rep.coachNote}</p>
      </div>
    </div>`;
  }).join('');

  // Flags section
  const gpsFlagsHtml = gpsFlags.length ? `
    <div class="flag-card">
      <h4>🚫 GPS Violations — Not At Location</h4>
      ${gpsFlags.map(f => `<div class="flag-row"><span class="flag-icon">🚫</span><span class="flag-text red">${f.repName} — ${f.text}</span></div>`).join('')}
    </div>` : '';

  const pipelineFlagsHtml = pipelineFlags.length ? `
    <div class="flag-card yellow">
      <h4>⏱️ Pipeline Violations — 72-Hour Rule</h4>
      ${pipelineFlags.map(f => `<div class="flag-row"><span class="flag-icon">⚠️</span><span class="flag-text yellow">${f.repName} — ${f.text}</span></div>`).join('')}
    </div>` : '';

  // Owner action items
  const urgentReps = sorted.filter(r => r.totalScore < 60);
  const watchReps = sorted.filter(r => r.totalScore >= 60 && r.totalScore < 70);
  const eliteReps = sorted.filter(r => r.totalScore >= 90);

  const ownerActions = [
    ...urgentReps.map(r => `<div class="action-item"><div class="action-priority"><span class="priority-badge p-urgent">URGENT</span></div><div class="action-text"><strong style="color:#fff;">${r.name}</strong> — Score: ${r.totalScore}. ${r.coachNote}</div></div>`),
    ...watchReps.map(r => `<div class="action-item"><div class="action-priority"><span class="priority-badge p-watch">WATCH</span></div><div class="action-text"><strong style="color:#fff;">${r.name}</strong> — Score: ${r.totalScore}. Trending toward failing — check in before next shift.</div></div>`),
    ...eliteReps.map(r => `<div class="action-item"><div class="action-priority"><span class="priority-badge p-good">RECOGNIZE</span></div><div class="action-text"><strong style="color:#fff;">${r.name}</strong> — Score: ${r.totalScore}. Elite performance — recognize publicly in team meeting.</div></div>`),
  ].join('') || '<div class="action-item"><div class="action-text" style="color:#6666aa;">No urgent actions today — team is performing within acceptable range.</div></div>';

  // Split jobs
  const splitJobsHtml = splitJobs.length ? splitJobs.map(s =>
    `<div class="split-row"><div class="split-job">${s.jobName}</div><div class="split-reps">${s.repName} / ${s.assigneeName}</div><div class="split-pct">${s.repPct}% / ${s.assigneePct}%</div></div>`
  ).join('') : '<div style="padding:12px 0;color:#444466;font-size:13px;">No split jobs today.</div>';

  // Conduct section
  const conductHtml = conductFlags.length ? `
  <div class="section-header" style="margin-top:4px;border-left-color:#e94560;">
    <h2 style="color:#e94560;">🚨 CONDUCT VIOLATIONS — REQUIRES OWNER REVIEW</h2>
  </div>
  <div class="conduct-section" style="padding:12px 40px 16px;background:#0d0d1a;">
    <div class="conduct-card">
      <h3>⚠️ CONDUCT VIOLATION LOG — ${dateLabel}</h3>
      ${conductFlags.map(f => `
      <div class="conduct-item">
        <div class="conduct-rep">${f.repName}</div>
        <div class="conduct-type">VIOLATION TYPE: ${f.violationType || 'Conduct Issue'}</div>
        <div class="conduct-summary">${f.text}</div>
      </div>`).join('')}
      <div class="conduct-action"><p>⚠️ OWNER ACTION REQUIRED: Review flagged emails before affected rep's next shift.</p></div>
    </div>
  </div>` : '';

  // Read the CSS from the mock file and embed it — use same styles
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>OVERWATCH — ${dateLabel}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d0d1a; font-family:Arial,sans-serif; color:#e0e0e0; }
.wrapper { max-width:780px; margin:0 auto; background:#0d0d1a; }
.header { background:linear-gradient(135deg,#0a0a1a 0%,#1a1a3e 100%); padding:32px 40px 24px; border-bottom:3px solid #e94560; }
.header-top { display:flex; justify-content:space-between; align-items:flex-start; }
.brand { display:flex; align-items:center; gap:12px; }
.brand-icon { width:44px;height:44px;background:#e94560;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:white; }
.brand-text h1 { font-size:24px;font-weight:900;color:#fff;letter-spacing:4px; }
.brand-text p { font-size:11px;color:#8888aa;letter-spacing:2px;margin-top:2px; }
.report-meta { text-align:right; }
.report-meta .date { font-size:13px;color:#aaaacc; }
.report-meta .company { font-size:15px;font-weight:700;color:#fff;margin-top:4px; }
.snapshot { background:#13132a;padding:16px 40px;display:flex;gap:0;border-bottom:1px solid #2a2a4a; }
.snap-item { flex:1;text-align:center;padding:8px 0;border-right:1px solid #2a2a4a; }
.snap-item:last-child { border-right:none; }
.snap-val { font-size:26px;font-weight:900;color:#fff; }
.snap-val.green { color:#2ecc71; } .snap-val.red { color:#e94560; } .snap-val.gold { color:#f1c40f; }
.snap-label { font-size:10px;color:#6666aa;letter-spacing:1px;margin-top:4px;text-transform:uppercase; }
.section-header { background:#1a1a3e;padding:10px 40px;border-left:4px solid #e94560;margin-top:2px; }
.section-header h2 { font-size:11px;font-weight:700;color:#e94560;letter-spacing:3px;text-transform:uppercase; }
.leaderboard { padding:0 40px 8px;background:#0f0f22; }
.lb-row { display:flex;align-items:center;padding:10px 16px;border-radius:8px;margin:6px 0;gap:12px; }
.lb-row.gold-row { background:linear-gradient(90deg,rgba(241,196,15,.15),rgba(241,196,15,.04));border:1px solid rgba(241,196,15,.3); }
.lb-row.silver-row { background:linear-gradient(90deg,rgba(189,195,199,.12),rgba(189,195,199,.03));border:1px solid rgba(189,195,199,.25); }
.lb-row.bronze-row { background:linear-gradient(90deg,rgba(180,100,30,.12),rgba(180,100,30,.03));border:1px solid rgba(180,100,30,.25); }
.lb-row.normal-row { background:#13132a;border:1px solid #1e1e3a; }
.lb-row.fail-row { background:rgba(233,69,96,.08);border:1px solid rgba(233,69,96,.25); }
.lb-rank { width:28px;font-size:13px;font-weight:900;color:#6666aa;text-align:center; }
.lb-name { flex:1;font-size:14px;font-weight:700;color:#e0e0ff; }
.lb-score { font-size:22px;font-weight:900;color:#fff;width:52px;text-align:right; }
.lb-grade { width:32px;text-align:center; }
.grade-badge { display:inline-block;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:900; }
.lb-trend { width:28px;text-align:center;font-size:16px; }
.lb-avg { font-size:11px;color:#6666aa;width:56px;text-align:right; }
.rep-cards { padding:0 40px;background:#0d0d1a; }
.rep-card { background:#13132a;border:1px solid #1e1e3a;border-radius:12px;margin:12px 0;overflow:hidden; }
.rep-card.elite { border-color:rgba(241,196,15,.4); }
.rep-card.on-target { border-color:rgba(46,204,113,.3); }
.rep-card.fail { border-color:rgba(233,69,96,.35); }
.card-header { padding:16px 20px 12px;display:flex;align-items:center;gap:14px;border-bottom:1px solid #1e1e3a; }
.card-avatar { width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#fff;flex-shrink:0; }
.av-blue { background:linear-gradient(135deg,#0f3460,#1a5276); }
.card-info { flex:1; }
.card-name { font-size:16px;font-weight:800;color:#fff; }
.card-role { font-size:11px;color:#6666aa;letter-spacing:1px;margin-top:2px; }
.card-score-block { text-align:right; }
.card-big-score { font-size:36px;font-weight:900;line-height:1; }
.score-elite { color:#f1c40f; } .score-ontarget { color:#2ecc71; } .score-ok { color:#3498db; } .score-low { color:#e67e22; } .score-fail { color:#e94560; }
.card-grade-trend { display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:4px; }
.platform-bars { padding:12px 20px;display:flex;gap:8px;border-bottom:1px solid #1e1e3a; }
.plat-bar { flex:1;background:#0d0d1a;border-radius:6px;padding:8px 10px;text-align:center; }
.plat-name { font-size:9px;color:#6666aa;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px; }
.plat-pts { font-size:18px;font-weight:900; }
.plat-max { font-size:9px;color:#444466; }
.pts-jn { color:#3498db; } .pts-sr { color:#e67e22; } .pts-cc { color:#9b59b6; } .pts-em { color:#1abc9c; }
.activity-detail { padding:12px 20px;border-bottom:1px solid #1e1e3a; }
.activity-detail h4 { font-size:10px;color:#6666aa;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px; }
.act-item { display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a2e; }
.act-item:last-child { border-bottom:none; }
.act-label { font-size:12px;color:#aaaacc; }
.act-val { font-size:12px;font-weight:700; }
.val-good { color:#2ecc71; } .val-bad { color:#e94560; } .val-neutral { color:#fff; }
.flag-row { display:flex;align-items:flex-start;gap:8px;padding:5px 0; }
.flag-icon { font-size:13px;flex-shrink:0;margin-top:1px; }
.flag-text { font-size:12px;color:#cc8866; }
.flag-text.red { color:#e94560; } .flag-text.yellow { color:#f1c40f; }
.coach-note { padding:12px 20px 16px;background:#0f0f22; }
.coach-note h4 { font-size:10px;color:#e94560;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px; }
.coach-text { font-size:13px;color:#aaaadd;font-style:italic;line-height:1.6;border-left:3px solid #e94560;padding-left:12px; }
.flags-section { padding:0 40px 12px;background:#0d0d1a; }
.flag-card { background:#1a0f0f;border:1px solid rgba(233,69,96,.3);border-radius:8px;padding:14px 18px;margin:6px 0; }
.flag-card.yellow { background:#1a1a0a;border-color:rgba(241,196,15,.3); }
.flag-card h4 { font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;color:#e94560; }
.flag-card.yellow h4 { color:#f1c40f; }
.actions-section { padding:12px 40px 16px;background:#0f0f22; }
.action-item { display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #1a1a2e;align-items:flex-start; }
.action-item:last-child { border-bottom:none; }
.action-priority { width:64px;flex-shrink:0; }
.priority-badge { padding:3px 8px;border-radius:4px;font-size:10px;font-weight:700;text-align:center;letter-spacing:1px;display:block; }
.p-urgent { background:rgba(233,69,96,.2);color:#e94560;border:1px solid #e94560; }
.p-watch { background:rgba(241,196,15,.15);color:#f1c40f;border:1px solid #f1c40f; }
.p-good { background:rgba(46,204,113,.15);color:#2ecc71;border:1px solid #2ecc71; }
.action-text { font-size:13px;color:#ccccdd;line-height:1.5; }
.conduct-section { padding:12px 40px 16px;background:#0d0d1a; }
.conduct-card { background:#1a0505;border:2px solid #e94560;border-radius:8px;padding:16px 20px; }
.conduct-card h3 { color:#e94560;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px; }
.conduct-item { background:rgba(233,69,96,.08);border-radius:6px;padding:10px 14px;margin:8px 0; }
.conduct-rep { font-size:13px;font-weight:700;color:#fff; }
.conduct-type { font-size:11px;color:#e94560;margin:3px 0; }
.conduct-summary { font-size:12px;color:#aaaacc;font-style:italic; }
.conduct-action { background:rgba(233,69,96,.15);border-radius:6px;padding:10px 14px;margin-top:12px; }
.conduct-action p { font-size:12px;color:#e94560;font-weight:700; }
.split-section { padding:12px 40px 16px;background:#0f0f22; }
.split-row { display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #1a1a2e;align-items:center;font-size:12px; }
.split-job { flex:2;color:#aaaacc; } .split-reps { flex:2;color:#fff;font-weight:700; } .split-pct { flex:1;color:#3498db;text-align:right; }
.footer { background:#080810;padding:20px 40px;border-top:1px solid #1a1a2e;display:flex;justify-content:space-between;align-items:center; }
.footer-brand { font-size:11px;color:#333355;letter-spacing:2px; }
.footer-time { font-size:11px;color:#333355; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="header-top">
      <div class="brand">
        <div class="brand-icon">OW</div>
        <div class="brand-text"><h1>OVERWATCH</h1><p>DAILY PERFORMANCE INTELLIGENCE</p></div>
      </div>
      <div class="report-meta">
        <div class="date">${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
        <div class="company">Cox Roofing &amp; Restoration</div>
      </div>
    </div>
  </div>

  <div class="snapshot">
    <div class="snap-item"><div class="snap-val">${sorted.length}</div><div class="snap-label">Reps Active</div></div>
    <div class="snap-item"><div class="snap-val gold">${teamAvg}</div><div class="snap-label">Team Avg Score</div></div>
    <div class="snap-item"><div class="snap-val green">${topScore}</div><div class="snap-label">Top Score</div></div>
    <div class="snap-item"><div class="snap-val">${eliteCount}</div><div class="snap-label">Elite (A)</div></div>
    <div class="snap-item"><div class="snap-val">${onTargetCount}</div><div class="snap-label">On Target (B)</div></div>
    <div class="snap-item"><div class="snap-val red">${failCount}</div><div class="snap-label">Failing (F)</div></div>
  </div>

  <div class="section-header"><h2>📊 Daily Leaderboard — ${dateLabel}</h2></div>
  <div class="leaderboard">
    <div style="display:flex;padding:6px 16px;gap:12px;margin-top:8px;">
      <div style="width:28px;font-size:10px;color:#444466;text-align:center;">RNK</div>
      <div style="flex:1;font-size:10px;color:#444466;">REP NAME</div>
      <div style="width:52px;font-size:10px;color:#444466;text-align:right;">SCORE</div>
      <div style="width:32px;font-size:10px;color:#444466;text-align:center;">GRD</div>
      <div style="width:28px;font-size:10px;color:#444466;text-align:center;">TRD</div>
      <div style="width:56px;font-size:10px;color:#444466;text-align:right;">7D AVG</div>
    </div>
    ${lbRows}
  </div>

  <div class="section-header" style="margin-top:16px;"><h2>👤 Individual Rep Cards</h2></div>
  <div class="rep-cards">${repCards}</div>

  <div class="section-header" style="margin-top:16px;"><h2>🚨 Flags &amp; Alerts</h2></div>
  <div class="flags-section">${gpsFlagsHtml}${pipelineFlagsHtml}</div>

  <div class="section-header" style="margin-top:4px;"><h2>📋 Owner Action Items</h2></div>
  <div class="actions-section">${ownerActions}</div>

  ${conductHtml}

  <div class="section-header" style="margin-top:4px;"><h2>🤝 Split Jobs Summary</h2></div>
  <div class="split-section">
    <div style="display:flex;gap:12px;padding:4px 0 8px;border-bottom:1px solid #2a2a4a;">
      <div style="flex:2;font-size:10px;color:#444466;text-transform:uppercase;letter-spacing:1px;">JOB</div>
      <div style="flex:2;font-size:10px;color:#444466;text-transform:uppercase;letter-spacing:1px;">REPS</div>
      <div style="flex:1;font-size:10px;color:#444466;text-transform:uppercase;letter-spacing:1px;text-align:right;">SPLIT</div>
    </div>
    ${splitJobsHtml}
  </div>

  <div class="footer">
    <div class="footer-brand">OVERWATCH  •  COX ROOFING &amp; RESTORATION  •  CONFIDENTIAL</div>
    <div class="footer-time">Generated 8:00 AM EST  •  Data through 11:59 PM ${dateLabel}</div>
  </div>
</div>
</body>
</html>`;
}

// ── SAVE REPORT TO FILE ────────────────────────────────────────
async function saveReport(htmlContent, dateLabel) {

  // Create reports directory if it doesn't exist
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  // Save dated report
  const dateSlug = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(reportsDir, `overwatch-${dateSlug}.html`);
  fs.writeFileSync(reportPath, htmlContent);

  // Also overwrite latest.html so there's always one stable URL to bookmark
  const latestPath = path.join(reportsDir, 'latest.html');
  fs.writeFileSync(latestPath, htmlContent);

  // Write a simple index page listing all past reports
  const allReports = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('overwatch-') && f.endsWith('.html'))
    .sort()
    .reverse();

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>OVERWATCH — Report Archive</title>
<style>
  body { background:#0d0d1a; font-family:Arial,sans-serif; color:#e0e0e0; max-width:600px; margin:60px auto; padding:0 20px; }
  h1 { color:#e94560; letter-spacing:4px; font-size:22px; margin-bottom:6px; }
  p { color:#6666aa; font-size:13px; margin-bottom:32px; }
  a { display:block; padding:14px 20px; background:#13132a; border:1px solid #1e1e3a; border-radius:8px; color:#fff; text-decoration:none; margin-bottom:10px; font-size:15px; }
  a:hover { border-color:#e94560; }
  a span { float:right; color:#6666aa; font-size:12px; }
  .latest { border-color:rgba(46,204,113,.4); background:#0f1f1a; }
</style>
</head>
<body>
<h1>⬡ OVERWATCH</h1>
<p>Cox Roofing & Restoration — Daily Performance Reports</p>
<a class="latest" href="latest.html">📊 Latest Report (Today) <span>VIEW →</span></a>
${allReports.map(f => {
  const d = f.replace('overwatch-','').replace('.html','');
  const label = new Date(d + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  return `<a href="${f}">${label} <span>VIEW →</span></a>`;
}).join('\n')}
</body>
</html>`;

  fs.writeFileSync(path.join(reportsDir, 'index.html'), indexHtml);

  console.log(`Report saved: ${reportPath}`);
  console.log(`Latest report: reports/latest.html`);
  console.log(`Archive index: reports/index.html`);
}

// ── MAIN ───────────────────────────────────────────────────────
async function main() {
  console.log('OVERWATCH starting...');
  const dateRange = getYesterdayRange();
  console.log(`Processing data for: ${dateRange.label}`);

  try {
    // 1. Fetch data
    const [jnData, srData] = await Promise.all([
      fetchJobNimbusData(dateRange),
      fetchSalesRabbitData(dateRange)
    ]);

    console.log(`JobNimbus: ${jnData.activities.length} activities, ${jnData.jobs.length} jobs`);
    console.log(`Sales Rabbit: ${srData.leads.length} leads, ${srData.users.length} users`);

    // 2. Build rep list from Sales Rabbit users (source of truth for active reps)
    const reps = srData.users.filter(u => !u.is_admin);
console.log('First rep raw object:', JSON.stringify(reps[0], null, 2));
console.log('Total reps:', reps.length);

    if (reps.length === 0) {
      console.log('No reps found — check Sales Rabbit API connection');
      // Still send a report noting the issue
    }

    // 3. Score each rep
    const repResults = reps.map(rep => {
      const repId = rep.id || rep.user_id;
      const repName = `${rep.firstName || rep.first_name || ''} ${rep.lastName || rep.last_name || ''}`.trim() || rep.name || rep.displayName || `Rep ${repId}`;

      // Filter activities for this rep
      const repJNActivities = jnData.activities.filter(a =>
        a.created_by === repId || a.assigned_to === repId || a.sales_rep_id === repId
      );
      const repSRLeads = srData.leads.filter(l => l.user_id === repId || l.assigned_to === repId);

      // Score platforms
      const jnScore = scoreJobNimbus(repJNActivities, jnData.jobs, repId, dateRange);
      const srScore = scoreSalesRabbit(repSRLeads, rep);

      // CompanyCam and Email default to 0 until APIs are connected
      const ccPts = 0;
      const emailPts = 0;

      // Total score
      let totalScore = jnScore.pts + srScore.pts + ccPts + emailPts;

      // Auto-elite override
      if (jnScore.contracts >= WEIGHTS.autoEliteThreshold) {
        totalScore = WEIGHTS.autoEliteScore;
      }

      totalScore = Math.min(100, Math.max(0, Math.round(totalScore)));

      // All flags combined
      const flags = [...jnScore.flags, ...srScore.flags];

      // Coach's note
      const coachNote = generateCoachNote(
        { name: repName },
        jnScore, srScore, emailPts, ccPts, flags
      );

      return {
        name: repName,
        repId,
        totalScore,
        jn: jnScore,
        sr: srScore,
        ccPts,
        emailPts,
        flags,
        coachNote,
        sevenDayAvg: null  // Will be populated once score history exists
      };
    });

    // 4. Resolve split jobs
    const splitJobs = [];
    for (const job of jnData.jobs) {
      const split = resolveSplitCredit(job, jnData.activities);
      if (split) {
        const repName = reps.find(r => r.id === split.repId)?.first_name || split.repId;
        const assigneeName = reps.find(r => r.id === split.assigneeId)?.first_name || split.assigneeId;
        splitJobs.push({ ...split, repName, assigneeName });
      }
    }

    // 5. Build and save report
    const html = buildHTMLReport(repResults, dateRange.label, splitJobs);
    await saveReport(html, dateRange.label);

    console.log('OVERWATCH complete.');

  } catch (err) {
    console.error('OVERWATCH error:', err);
    process.exit(1);
  }
}

main();
