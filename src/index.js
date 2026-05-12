// OVERWATCH — Cox Roofing & Restoration
// Daily Performance Intelligence System

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  jobnimbus: {
    apiKey: process.env.JOBNIMBUS_API_KEY,
    baseUrl: 'app.jobnimbus.com',
    basePath: '/api1'
  },
  salesRabbit: {
    apiKey: process.env.SALESRABBIT_API_KEY,
    baseUrl: 'api.salesrabbit.com'
  }
};

const WEIGHTS = {
  jn: { contract: 20, estimate: 8, apptSelf: 5, apptCompany: 2, lead: 3, stage: 1, note: 0.5, task: 0.5, penalty: -5, ceiling: 40 },
  sr: { pin: 0.15, apptBonus: 3, interestedBonus: 1, notHomeBonus: 0.25, ceiling: 25 },
  autoEliteAt: 2,
  autoEliteScore: 95
};

const EXCLUDE_REPS = ['mishell cox', 'chris cox', 'chris sanson'];

function apiGet(host, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: urlPath, method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data, raw: data.slice(0,200) }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getYesterday() {
  const now = new Date();
  const y = new Date(now); y.setDate(y.getDate() - 1); y.setHours(0,0,0,0);
  const e = new Date(y); e.setHours(23,59,59,999);
  return {
    start: Math.floor(y.getTime()/1000),
    end: Math.floor(e.getTime()/1000),
    label: y.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})
  };
}

async function fetchJN(dateRange) {
  const h = { 'Authorization': `Bearer ${CONFIG.jobnimbus.apiKey}`, 'Content-Type': 'application/json' };

  // Fetch activities per job for yesterday's date range
  // JobNimbus requires job-scoped or contact-scoped activity queries
  // Activities endpoint doesn't support date filtering — skip it
  // We score from tasks + jobs instead which return full data
  console.log('Skipping activities endpoint — scoring from tasks + jobs');
  const actRes = { status: 200, body: { results: [] } };

  // Also try tasks endpoint separately
  const tasksRes = await apiGet(CONFIG.jobnimbus.baseUrl,
    `${CONFIG.jobnimbus.basePath}/tasks?date_start=${dateRange.start}&date_end=${dateRange.end}&limit=1000&sort=-date_created`, h);
  console.log(`JN Tasks: status=${tasksRes.status}, count=${tasksRes.body?.results?.length ?? 0}`);

  // Also pull contacts created yesterday — captures new leads
  const contactsRes = await apiGet(CONFIG.jobnimbus.baseUrl,
    `${CONFIG.jobnimbus.basePath}/contacts?date_start=${dateRange.start}&date_end=${dateRange.end}&limit=500`, h);
  console.log(`JN Contacts (new yesterday): status=${contactsRes.status}, count=${contactsRes.body?.results?.length ?? 0}`);

  // Jobs — only active, non-closed, updated in last 30 days
  const thirtyDaysAgo = Math.floor(Date.now()/1000) - (30 * 24 * 3600);
  const jobsRes = await apiGet(CONFIG.jobnimbus.baseUrl, `${CONFIG.jobnimbus.basePath}/jobs?limit=500&sort=-date_updated`, h);
  console.log(`JN Jobs: status=${jobsRes.status}, count=${jobsRes.body?.results?.length ?? 0}`);

  const allJobs = jobsRes.status === 200 ? jobsRes.body.results || [] : [];
  // Filter to only active jobs updated in last 30 days
  const activeJobs = allJobs.filter(j => j.is_active !== false && j.is_closed !== true && (j.date_updated || 0) > thirtyDaysAgo);
  console.log(`JN Active jobs (30d): ${activeJobs.length}`);

  return {
    activities: [
      ...(tasksRes.status === 200 ? tasksRes.body.results || [] : []),
      ...(contactsRes.status === 200 ? contactsRes.body.results || [] : []),
    ],
    jobs: activeJobs,
    allJobs
  };
}

async function fetchSR(dateRange) {
  const h = { 'Authorization': `Bearer ${CONFIG.salesRabbit.apiKey}`, 'Content-Type': 'application/json' };
  const leadsRes = await apiGet(CONFIG.salesRabbit.baseUrl,
    `/leads?dateFrom=${new Date(dateRange.start*1000).toISOString()}&dateTo=${new Date(dateRange.end*1000).toISOString()}&limit=2000`, h);
  const usersRes = await apiGet(CONFIG.salesRabbit.baseUrl, `/users?limit=200`, h);
  console.log(`SR Leads: status=${leadsRes.status}, count=${leadsRes.body?.data?.length ?? leadsRes.body?.results?.length ?? 0}`);
  console.log(`SR Users: status=${usersRes.status}, count=${usersRes.body?.data?.length ?? usersRes.body?.results?.length ?? 0}`);
  return {
    leads: leadsRes.status === 200 ? leadsRes.body.data || leadsRes.body.results || [] : [],
    users: usersRes.status === 200 ? usersRes.body.data || usersRes.body.results || [] : []
  };
}

function scoreJN(activities, jobs, repName, dateRange) {
  let pts = 0, contracts = 0, estimates = 0, appointments = 0, leads = 0, stageMoves = 0, notes = 0, tasks = 0;
  const notesPerJob = {}, flags = [], detail = [];
  const BIZ_72 = 72 * 3600;

  // Filter to yesterday's activities only
  const todaysActivities = activities.filter(a => {
    const created = a.date_created || a.date_updated || 0;
    return created >= dateRange.start && created <= dateRange.end;
  });

  for (const act of todaysActivities) {
    const type = (act.record_type_name || act.type || '').toLowerCase().trim();
    const note = (act.note || act.description || '').toLowerCase();
    const jobId = act.job_id || act.jnid || 'general';

    if (type === 'status changed' && (note.includes('=> sold') || note.includes('=> approved') || note.includes('=> won') || note.includes('contract signed'))) {
      contracts++; pts += WEIGHTS.jn.contract;
      detail.push({ label: 'Contract / Job Sold', value: `+${WEIGHTS.jn.contract} pts`, good: true });
    } else if (type.includes('estimate')) {
      estimates++; pts += WEIGHTS.jn.estimate;
      detail.push({ label: 'Estimate Submitted', value: `+${WEIGHTS.jn.estimate} pts`, good: true });
    } else if (type === 'task created' || type.includes('appointment') || type.includes('scheduled') || note.includes('appointment set') || note.includes('inspection scheduled')) {
      appointments++;
      const isSelf = !note.includes('company') && !note.includes('provided lead');
      const p = isSelf ? WEIGHTS.jn.apptSelf : WEIGHTS.jn.apptCompany;
      pts += p;
      detail.push({ label: `Appointment Set (${isSelf ? 'Self-Gen' : 'Company Lead'})`, value: `+${p} pts`, good: true });
    } else if (type === 'job created' || type === 'contact created') {
      leads++; pts += WEIGHTS.jn.lead;
      detail.push({ label: 'Lead Created', value: `+${WEIGHTS.jn.lead} pts`, good: true });
    } else if (type === 'status changed' || type.includes('stage')) {
      if (stageMoves < 5) { stageMoves++; pts += WEIGHTS.jn.stage; }
    } else if (type.includes('email')) {
      pts += 2;
    } else if (type.includes('note') || type.includes('comment')) {
      notesPerJob[jobId] = (notesPerJob[jobId] || 0) + 1;
      if (notesPerJob[jobId] <= 5) { notes++; pts += WEIGHTS.jn.note; }
    } else if (type.includes('task')) {
      if (tasks < 4) { tasks++; pts += WEIGHTS.jn.task; }
    }
  }

  // Pipeline check — only on active jobs, max 5 violations reported
  const repJobs = jobs.filter(j =>
    (j.sales_rep_name || '').toLowerCase() === repName.toLowerCase() ||
    (j.owners || []).some(o => (o.name || '').toLowerCase() === repName.toLowerCase())
  );
  let pipelineViolations = 0; const staleJobs = [];
  for (const job of repJobs) {
    const last = job.date_updated || job.date_status_change;
    if (!last) continue;
    const age = dateRange.end - last;
    if (age > BIZ_72) {
      pipelineViolations++;
      if (staleJobs.length < 5) { // Only show first 5 in flags, still count all
        const hrs = Math.floor(age/3600);
        staleJobs.push({ name: job.name || 'Unnamed', hoursStale: hrs });
        flags.push({ type: 'pipeline', text: `Job stale ${hrs}hrs: "${job.name || 'Unnamed'}"`, severity: 'yellow' });
      }
      pts += WEIGHTS.jn.penalty;
    }
  }

  if (stageMoves > 0) detail.push({ label: 'Stage Moves', value: `${stageMoves}`, good: true });
  if (notes > 0) detail.push({ label: 'Notes Logged', value: `${notes}`, good: true });

  pts = Math.min(WEIGHTS.jn.ceiling, Math.max(0, pts));
  return { pts, contracts, estimates, appointments, leads, stageMoves, notes, tasks, pipelineViolations, staleJobs, flags, detail };
}

function scoreSR(leads) {
  let pts = 0, atLocation = 0, appointmentsFromDoor = 0;
  const flags = [], detail = [];

  for (const lead of leads) {
    atLocation++;
    pts += WEIGHTS.sr.pin;
    const outcome = (lead.status || lead.status_name || '').toLowerCase();
    if (outcome.includes('appointment') || outcome.includes('set')) {
      appointmentsFromDoor++; pts += WEIGHTS.sr.apptBonus;
    } else if (outcome.includes('interest')) {
      pts += WEIGHTS.sr.interestedBonus;
    } else if (outcome.includes('not home') || outcome.includes('not interested')) {
      pts += WEIGHTS.sr.notHomeBonus;
    }
  }

  detail.push({ label: 'Doors Knocked (Sales Rabbit)', value: `${atLocation}`, good: atLocation >= 80 });
  if (atLocation >= 100 && appointmentsFromDoor === 0) {
    flags.push({ type: 'canvassing', text: '100+ doors with zero appointments — revisit door pitch', severity: 'yellow' });
  }

  pts = Math.min(WEIGHTS.sr.ceiling, Math.max(0, pts));
  return { pts, atLocation, nearLocation: 0, notAtLocation: 0, appointmentsFromDoor, totalPins: atLocation, flags, detail };
}

function getGrade(score) {
  if (score >= 90) return { letter: 'A', color: '#2ecc71', tier: 'ELITE', bg: '#1a4a2e' };
  if (score >= 80) return { letter: 'B', color: '#3498db', tier: 'ON TARGET', bg: '#1a3a4a' };
  if (score >= 70) return { letter: 'C', color: '#f1c40f', tier: 'ACCEPTABLE', bg: '#3a3a1a' };
  if (score >= 60) return { letter: 'D', color: '#e67e22', tier: 'BELOW STANDARD', bg: '#3a2a1a' };
  return { letter: 'F', color: '#e94560', tier: 'FAILING', bg: '#3a1a1a' };
}

function getTrend(today, avg) {
  const d = today - avg;
  if (d > 5) return { arrow: '↑', color: '#2ecc71' };
  if (d < -5) return { arrow: '↓', color: '#e94560' };
  return { arrow: '→', color: '#f1c40f' };
}

function coachNote(repName, jn, sr) {
  const notes = [];
  if (jn.contracts >= 2) notes.push(`${repName} triggered the auto-elite override with ${jn.contracts} contracts today. Elite performance.`);
  else if (jn.contracts === 1) notes.push(`${repName} closed 1 contract today. Push for the 2nd close consistently.`);
  else if (jn.estimates > 0) notes.push(`${repName} submitted ${jn.estimates} estimate(s) without a close. Focus on the gap between estimate and signature.`);
  else notes.push(`${repName} had no contracts or estimates today. Top of funnel needs attention.`);
  if (jn.pipelineViolations > 0) notes.push(`${jn.pipelineViolations} active job(s) went dark beyond 72 hours — pipeline discipline is costing points.`);
  if (sr.atLocation >= 80) notes.push(`Strong canvassing effort with ${sr.atLocation} doors knocked.`);
  else if (sr.atLocation > 0) notes.push(`${sr.atLocation} doors knocked today — push toward the 100-door daily target.`);
  return notes.join(' ');
}

function buildReport(results, dateLabel, debugInfo) {
  const sorted = [...results].sort((a,b) => b.score - a.score);
  const teamAvg = sorted.length ? Math.round(sorted.reduce((s,r) => s+r.score,0)/sorted.length) : 0;
  const topScore = sorted[0]?.score || 0;
  const eliteCount = sorted.filter(r => r.score >= 90).length;
  const onTargetCount = sorted.filter(r => r.score >= 80 && r.score < 90).length;
  const failCount = sorted.filter(r => r.score < 60).length;

  const lbRows = sorted.map((rep,i) => {
    const g = getGrade(rep.score); const t = getTrend(rep.score, rep.score);
    const cls = i===0?'gold-row':i===1?'silver-row':i===2?'bronze-row':rep.score<60?'fail-row':'normal-row';
    const icon = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}`;
    return `<div class="lb-row ${cls}">
      <div class="lb-rank">${icon}</div>
      <div class="lb-name">${rep.name}</div>
      <div class="lb-score" style="color:${g.color}">${rep.score}</div>
      <div class="lb-grade"><span class="grade-badge" style="background:${g.bg};color:${g.color};border:1px solid ${g.color}">${g.letter}</span></div>
      <div class="lb-trend" style="color:${t.color}">${t.arrow}</div>
      <div class="lb-avg">— avg</div>
    </div>`;
  }).join('');

  const repCards = sorted.map(rep => {
    const g = getGrade(rep.score); const t = getTrend(rep.score, rep.score);
    const initials = rep.name.split(' ').map(n=>n[0]).join('').slice(0,2);
    const cls = rep.score>=90?'elite':rep.score>=80?'on-target':rep.score<60?'fail':'';
    const scls = rep.score>=90?'score-elite':rep.score>=80?'score-ontarget':rep.score>=70?'score-ok':rep.score>=60?'score-low':'score-fail';
    const flags = rep.jn.flags.filter(f=>f.type==='pipeline').slice(0,3).map(f=>`<div class="flag-row"><span>⚠️</span><span class="flag-text yellow">${f.text}</span></div>`).join('');
    return `<div class="rep-card ${cls}">
      <div class="card-header">
        <div class="card-avatar av-blue">${initials}</div>
        <div class="card-info"><div class="card-name">${rep.name}</div><div class="card-role">SALES REP • RANK #${sorted.indexOf(rep)+1}</div></div>
        <div class="card-score-block">
          <div class="card-big-score ${scls}">${rep.score}</div>
          <div class="card-grade-trend">
            <span class="grade-badge" style="background:${g.bg};color:${g.color};border:1px solid ${g.color};padding:3px 8px;border-radius:4px;font-size:12px;font-weight:900">${g.letter}</span>
            <span style="color:${t.color};font-size:18px">${t.arrow}</span>
          </div>
        </div>
      </div>
      <div class="platform-bars">
        <div class="plat-bar"><div class="plat-name">JobNimbus</div><div class="plat-pts pts-jn">${rep.jn.pts}</div><div class="plat-max">/40</div></div>
        <div class="plat-bar"><div class="plat-name">Sales Rabbit</div><div class="plat-pts pts-sr">${rep.sr.pts}</div><div class="plat-max">/25</div></div>
        <div class="plat-bar"><div class="plat-name">CompanyCam</div><div class="plat-pts pts-cc">0</div><div class="plat-max">/15</div></div>
        <div class="plat-bar"><div class="plat-name">Email</div><div class="plat-pts pts-em">0</div><div class="plat-max">/20</div></div>
      </div>
      <div class="activity-detail"><h4>Activity Breakdown</h4>
        <div class="act-item"><span class="act-label">Contracts Signed</span><span class="act-val ${rep.jn.contracts>0?'val-good':'val-bad'}">${rep.jn.contracts}</span></div>
        <div class="act-item"><span class="act-label">Estimates Submitted</span><span class="act-val ${rep.jn.estimates>0?'val-good':'val-bad'}">${rep.jn.estimates}</span></div>
        <div class="act-item"><span class="act-label">Appointments Set</span><span class="act-val ${rep.jn.appointments>0?'val-good':'val-bad'}">${rep.jn.appointments}</span></div>
        <div class="act-item"><span class="act-label">Doors Knocked (Sales Rabbit)</span><span class="act-val ${rep.sr.atLocation>=80?'val-good':'val-bad'}">${rep.sr.atLocation}</span></div>
        <div class="act-item"><span class="act-label">Pipeline Violations (72hr)</span><span class="act-val ${rep.jn.pipelineViolations===0?'val-good':'val-bad'}">${rep.jn.pipelineViolations===0?'✓ All clear':'⚠️ '+rep.jn.pipelineViolations+' stale jobs'}</span></div>
      </div>
      ${flags ? `<div class="activity-detail">${flags}</div>` : ''}
      <div class="coach-note"><h4>🎯 Coach's Note</h4><p class="coach-text">${rep.coach}</p></div>
    </div>`;
  }).join('');

  const pipelineFlags = sorted.flatMap(r => r.jn.flags.filter(f=>f.type==='pipeline').slice(0,3).map(f=>({...f,repName:r.name})));
  const pipelineHtml = pipelineFlags.length ? `<div class="flag-card yellow"><h4>⏱️ Pipeline Violations — 72-Hour Rule</h4>${pipelineFlags.map(f=>`<div class="flag-row"><span>⚠️</span><span class="flag-text yellow">${f.repName} — ${f.text}</span></div>`).join('')}</div>` : '';

  const urgentReps = sorted.filter(r=>r.score<60);
  const eliteReps = sorted.filter(r=>r.score>=90);
  const ownerActions = [
    ...urgentReps.map(r=>`<div class="action-item"><div class="action-priority"><span class="priority-badge p-urgent">URGENT</span></div><div class="action-text"><strong style="color:#fff">${r.name}</strong> — Score: ${r.score}. ${r.coach}</div></div>`),
    ...eliteReps.map(r=>`<div class="action-item"><div class="action-priority"><span class="priority-badge p-good">RECOGNIZE</span></div><div class="action-text"><strong style="color:#fff">${r.name}</strong> — Score: ${r.score}. Elite performance — recognize publicly.</div></div>`),
  ].join('') || '<div class="action-item"><div class="action-text" style="color:#6666aa">No urgent actions today.</div></div>';

  // Debug section
  const debugHtml = debugInfo ? `
  <div style="background:#0a0a1a;border:1px solid #333;border-radius:8px;padding:16px;margin:16px 40px;font-family:monospace;font-size:11px;color:#666">
    <div style="color:#e94560;font-weight:bold;margin-bottom:8px">DEBUG INFO (remove after calibration)</div>
    ${debugInfo.map(d=>`<div style="margin:2px 0;color:#888">${d}</div>`).join('')}
  </div>` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>OVERWATCH — ${dateLabel}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0d1a;font-family:Arial,sans-serif;color:#e0e0e0}.wrapper{max-width:780px;margin:0 auto;background:#0d0d1a}
.header{background:linear-gradient(135deg,#0a0a1a,#1a1a3e);padding:32px 40px 24px;border-bottom:3px solid #e94560}.header-top{display:flex;justify-content:space-between;align-items:flex-start}.brand{display:flex;align-items:center;gap:12px}.brand-icon{width:44px;height:44px;background:#e94560;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:white}.brand-text h1{font-size:24px;font-weight:900;color:#fff;letter-spacing:4px}.brand-text p{font-size:11px;color:#8888aa;letter-spacing:2px;margin-top:2px}.report-meta{text-align:right}.report-meta .date{font-size:13px;color:#aaaacc}.report-meta .company{font-size:15px;font-weight:700;color:#fff;margin-top:4px}
.snapshot{background:#13132a;padding:16px 40px;display:flex;gap:0;border-bottom:1px solid #2a2a4a}.snap-item{flex:1;text-align:center;padding:8px 0;border-right:1px solid #2a2a4a}.snap-item:last-child{border-right:none}.snap-val{font-size:26px;font-weight:900;color:#fff}.snap-val.green{color:#2ecc71}.snap-val.red{color:#e94560}.snap-val.gold{color:#f1c40f}.snap-label{font-size:10px;color:#6666aa;letter-spacing:1px;margin-top:4px;text-transform:uppercase}
.section-header{background:#1a1a3e;padding:10px 40px;border-left:4px solid #e94560;margin-top:2px}.section-header h2{font-size:11px;font-weight:700;color:#e94560;letter-spacing:3px;text-transform:uppercase}
.leaderboard{padding:0 40px 8px;background:#0f0f22}.lb-row{display:flex;align-items:center;padding:10px 16px;border-radius:8px;margin:6px 0;gap:12px}.lb-row.gold-row{background:linear-gradient(90deg,rgba(241,196,15,.15),rgba(241,196,15,.04));border:1px solid rgba(241,196,15,.3)}.lb-row.silver-row{background:linear-gradient(90deg,rgba(189,195,199,.12),rgba(189,195,199,.03));border:1px solid rgba(189,195,199,.25)}.lb-row.bronze-row{background:linear-gradient(90deg,rgba(180,100,30,.12),rgba(180,100,30,.03));border:1px solid rgba(180,100,30,.25)}.lb-row.normal-row{background:#13132a;border:1px solid #1e1e3a}.lb-row.fail-row{background:rgba(233,69,96,.08);border:1px solid rgba(233,69,96,.25)}.lb-rank{width:28px;font-size:13px;font-weight:900;color:#6666aa;text-align:center}.lb-name{flex:1;font-size:14px;font-weight:700;color:#e0e0ff}.lb-score{font-size:22px;font-weight:900;color:#fff;width:52px;text-align:right}.lb-grade{width:32px;text-align:center}.grade-badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:900}.lb-trend{width:28px;text-align:center;font-size:16px}.lb-avg{font-size:11px;color:#6666aa;width:56px;text-align:right}
.rep-cards{padding:0 40px;background:#0d0d1a}.rep-card{background:#13132a;border:1px solid #1e1e3a;border-radius:12px;margin:12px 0;overflow:hidden}.rep-card.elite{border-color:rgba(241,196,15,.4)}.rep-card.on-target{border-color:rgba(46,204,113,.3)}.rep-card.fail{border-color:rgba(233,69,96,.35)}.card-header{padding:16px 20px 12px;display:flex;align-items:center;gap:14px;border-bottom:1px solid #1e1e3a}.card-avatar{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:#fff;flex-shrink:0}.av-blue{background:linear-gradient(135deg,#0f3460,#1a5276)}.card-info{flex:1}.card-name{font-size:16px;font-weight:800;color:#fff}.card-role{font-size:11px;color:#6666aa;letter-spacing:1px;margin-top:2px}.card-score-block{text-align:right}.card-big-score{font-size:36px;font-weight:900;line-height:1}.score-elite{color:#f1c40f}.score-ontarget{color:#2ecc71}.score-ok{color:#3498db}.score-low{color:#e67e22}.score-fail{color:#e94560}.card-grade-trend{display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:4px}
.platform-bars{padding:12px 20px;display:flex;gap:8px;border-bottom:1px solid #1e1e3a}.plat-bar{flex:1;background:#0d0d1a;border-radius:6px;padding:8px 10px;text-align:center}.plat-name{font-size:9px;color:#6666aa;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}.plat-pts{font-size:18px;font-weight:900}.plat-max{font-size:9px;color:#444466}.pts-jn{color:#3498db}.pts-sr{color:#e67e22}.pts-cc{color:#9b59b6}.pts-em{color:#1abc9c}
.activity-detail{padding:12px 20px;border-bottom:1px solid #1e1e3a}.activity-detail h4{font-size:10px;color:#6666aa;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}.act-item{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a2e}.act-item:last-child{border-bottom:none}.act-label{font-size:12px;color:#aaaacc}.act-val{font-size:12px;font-weight:700}.val-good{color:#2ecc71}.val-bad{color:#e94560}
.flag-row{display:flex;align-items:flex-start;gap:8px;padding:5px 0}.flag-text{font-size:12px;color:#cc8866}.flag-text.red{color:#e94560}.flag-text.yellow{color:#f1c40f}
.coach-note{padding:12px 20px 16px;background:#0f0f22}.coach-note h4{font-size:10px;color:#e94560;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}.coach-text{font-size:13px;color:#aaaadd;font-style:italic;line-height:1.6;border-left:3px solid #e94560;padding-left:12px}
.flags-section{padding:0 40px 12px;background:#0d0d1a}.flag-card{background:#1a0f0f;border:1px solid rgba(233,69,96,.3);border-radius:8px;padding:14px 18px;margin:6px 0}.flag-card.yellow{background:#1a1a0a;border-color:rgba(241,196,15,.3)}.flag-card h4{font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;color:#e94560}.flag-card.yellow h4{color:#f1c40f}
.actions-section{padding:12px 40px 16px;background:#0f0f22}.action-item{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #1a1a2e;align-items:flex-start}.action-item:last-child{border-bottom:none}.action-priority{width:64px;flex-shrink:0}.priority-badge{padding:3px 8px;border-radius:4px;font-size:10px;font-weight:700;text-align:center;letter-spacing:1px;display:block}.p-urgent{background:rgba(233,69,96,.2);color:#e94560;border:1px solid #e94560}.p-good{background:rgba(46,204,113,.15);color:#2ecc71;border:1px solid #2ecc71}.action-text{font-size:13px;color:#ccccdd;line-height:1.5}
.footer{background:#080810;padding:20px 40px;border-top:1px solid #1a1a2e;display:flex;justify-content:space-between;align-items:center}.footer-brand{font-size:11px;color:#333355;letter-spacing:2px}.footer-time{font-size:11px;color:#333355}
</style></head><body><div class="wrapper">
<div class="header"><div class="header-top">
  <div class="brand"><div class="brand-icon">OW</div><div class="brand-text"><h1>OVERWATCH</h1><p>DAILY PERFORMANCE INTELLIGENCE</p></div></div>
  <div class="report-meta"><div class="date">${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div><div class="company">Cox Roofing &amp; Restoration</div></div>
</div></div>
<div class="snapshot">
  <div class="snap-item"><div class="snap-val">${sorted.length}</div><div class="snap-label">Reps Active</div></div>
  <div class="snap-item"><div class="snap-val gold">${teamAvg}</div><div class="snap-label">Team Avg</div></div>
  <div class="snap-item"><div class="snap-val green">${topScore}</div><div class="snap-label">Top Score</div></div>
  <div class="snap-item"><div class="snap-val">${eliteCount}</div><div class="snap-label">Elite (A)</div></div>
  <div class="snap-item"><div class="snap-val">${onTargetCount}</div><div class="snap-label">On Target (B)</div></div>
  <div class="snap-item"><div class="snap-val red">${failCount}</div><div class="snap-label">Failing (F)</div></div>
</div>
<div class="section-header"><h2>📊 Daily Leaderboard — ${dateLabel}</h2></div>
<div class="leaderboard">
  <div style="display:flex;padding:6px 16px;gap:12px;margin-top:8px">
    <div style="width:28px;font-size:10px;color:#444466;text-align:center">RNK</div>
    <div style="flex:1;font-size:10px;color:#444466">REP NAME</div>
    <div style="width:52px;font-size:10px;color:#444466;text-align:right">SCORE</div>
    <div style="width:32px;font-size:10px;color:#444466;text-align:center">GRD</div>
    <div style="width:28px;font-size:10px;color:#444466;text-align:center">TRD</div>
    <div style="width:56px;font-size:10px;color:#444466;text-align:right">7D AVG</div>
  </div>
  ${lbRows}
</div>
<div class="section-header" style="margin-top:16px"><h2>👤 Individual Rep Cards</h2></div>
<div class="rep-cards">${repCards}</div>
<div class="section-header" style="margin-top:16px"><h2>🚨 Flags &amp; Alerts</h2></div>
<div class="flags-section">${pipelineHtml || '<div style="padding:16px 0;color:#444466;font-size:13px">No flags today.</div>'}</div>
<div class="section-header" style="margin-top:4px"><h2>📋 Owner Action Items</h2></div>
<div class="actions-section">${ownerActions}</div>
${debugHtml}
<div class="footer">
  <div class="footer-brand">OVERWATCH • COX ROOFING &amp; RESTORATION • CONFIDENTIAL</div>
  <div class="footer-time">Generated 8:00 AM EST • Data through 11:59 PM ${dateLabel}</div>
</div>
</div></body></html>`;
}

async function saveReport(html, dateLabel) {
  const dir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const slug = new Date().toISOString().slice(0,10);
  fs.writeFileSync(path.join(dir, `overwatch-${slug}.html`), html);
  fs.writeFileSync(path.join(dir, 'latest.html'), html);
  const all = fs.readdirSync(dir).filter(f=>f.startsWith('overwatch-')&&f.endsWith('.html')).sort().reverse();
  const idx = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>OVERWATCH Archive</title>
<style>body{background:#0d0d1a;font-family:Arial,sans-serif;color:#e0e0e0;max-width:600px;margin:60px auto;padding:0 20px}h1{color:#e94560;letter-spacing:4px;font-size:22px;margin-bottom:6px}p{color:#6666aa;font-size:13px;margin-bottom:32px}a{display:block;padding:14px 20px;background:#13132a;border:1px solid #1e1e3a;border-radius:8px;color:#fff;text-decoration:none;margin-bottom:10px;font-size:15px}a:hover{border-color:#e94560}a span{float:right;color:#6666aa;font-size:12px}.latest{border-color:rgba(46,204,113,.4);background:#0f1f1a}</style></head>
<body><h1>OVERWATCH</h1><p>Cox Roofing &amp; Restoration — Daily Performance Reports</p>
<a class="latest" href="latest.html">📊 Latest Report <span>VIEW →</span></a>
${all.map(f=>{const d=f.replace('overwatch-','').replace('.html','');const l=new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});return `<a href="${f}">${l} <span>VIEW →</span></a>`;}).join('\n')}
</body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), idx);
  console.log(`Report saved: reports/overwatch-${slug}.html`);
}

async function main() {
  console.log('OVERWATCH starting...');
  const dateRange = getYesterday();
  console.log(`Date range: ${dateRange.label}`);

  try {
    const [jnData, srData] = await Promise.all([fetchJN(dateRange), fetchSR(dateRange)]);

    const reps = srData.users.filter(u => {
      if (u.isAdmin || u.is_admin) return false;
      const name = `${u.firstName||u.first_name||''} ${u.lastName||u.last_name||''}`.toLowerCase().trim();
      return !EXCLUDE_REPS.includes(name);
    });

    console.log(`Reps to score: ${reps.map(r=>`${r.firstName} ${r.lastName}`).join(', ')}`);
  // Show what created_by_name values actually exist in tasks
  const taskNames = [...new Set(jnData.activities.map(a => a.created_by_name || a.created_by || 'unknown'))];
  console.log(`Unique task creators (${taskNames.length}):`, taskNames.slice(0,20).join(', '));
    console.log(`Tasks matching yesterday's date range: ${jnData.activities.filter(a => { const c = a.date_created||0; return c >= dateRange.start && c <= dateRange.end; }).length}`);

    const debugInfo = [
      `JN Activities total: ${jnData.activities.length}`,
      `JN Active jobs (30d): ${jnData.jobs.length}`,
      `SR Leads today: ${srData.leads.length}`,
      `Reps found: ${reps.length}`,
    ];

    const results = reps.map(rep => {
      const repId = rep.id || rep.userId;
      const repName = `${rep.firstName||rep.first_name||''} ${rep.lastName||rep.last_name||''}`.trim() || `Rep ${repId}`;

      // Match JN activities by rep name
      const repActs = jnData.activities.filter(a => {
        const cb = (a.created_by_name || a.created_by || '').toLowerCase().trim();
        return cb === repName.toLowerCase().trim();
      });

      // Match SR leads by userId
      const repLeads = srData.leads.filter(l => String(l.userId) === String(repId));

      debugInfo.push(`${repName}: ${repActs.length} JN acts, ${repLeads.length} SR leads`);

      const jn = scoreJN(repActs, jnData.jobs, repName, dateRange);
      const sr = scoreSR(repLeads);

      let score = jn.pts + sr.pts;
      if (jn.contracts >= WEIGHTS.autoEliteAt) score = WEIGHTS.autoEliteScore;
      score = Math.min(100, Math.max(0, Math.round(score)));

      return {
        name: repName, repId, score,
        jn, sr, ccPts: 0, emailPts: 0,
        flags: [...jn.flags, ...sr.flags],
        coach: coachNote(repName, jn, sr)
      };
    });

    const html = buildReport(results, dateRange.label, debugInfo);
    await saveReport(html, dateRange.label);
    console.log('OVERWATCH complete.');

  } catch(err) {
    console.error('OVERWATCH error:', err);
    process.exit(1);
  }
}

main();
