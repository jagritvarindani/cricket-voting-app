// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public')); // serve static files from public/

// File paths — DATA_DIR points to Render persistent disk (/data)
// Falls back to local directory for development
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const votersFile = path.join(DATA_DIR, 'votersPool.json');
const resultsFile = path.join(DATA_DIR, 'matchResults.json');
const matchesFile = path.join(__dirname, 'matches.json'); // read-only, lives in repo

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Seed data files from bundled defaults if they don't exist on the volume yet
function seedIfMissing(dest, srcName) {
  if (!fs.existsSync(dest)) {
    const src = path.join(__dirname, 'data-defaults', srcName);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`Seeded ${dest} from defaults`);
    }
  }
}
seedIfMissing(votersFile, 'votersPool.json');
seedIfMissing(resultsFile, 'matchResults.json');

// Helper functions for votersPool.json
function readVotersData() {
  return JSON.parse(fs.readFileSync(votersFile, 'utf8'));
}
function writeVotersData(data) {
  fs.writeFileSync(votersFile, JSON.stringify(data, null, 2), 'utf8');
}

// Helper functions for matchResults.json
function readResultsData() {
  if (fs.existsSync(resultsFile)) {
    return JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  }
  return { results: [] };
}
function writeResultsData(data) {
  fs.writeFileSync(resultsFile, JSON.stringify(data, null, 2), 'utf8');
}

// Helper function for matches.json (read-only match schedule)
function readMatchesData() {
  if (fs.existsSync(matchesFile)) {
    return JSON.parse(fs.readFileSync(matchesFile, 'utf8'));
  }
  return [];
}

// ---------------------
// LOGIN ENDPOINT
// ---------------------
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const data = readVotersData();
  const user = data.votersPool.find(u => u.email === email && u.password === password);
  if (user) {
    const { password, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.json({ success: false, message: 'Invalid credentials' });
  }
});

// ---------------------
// VOTING ENDPOINT
// ---------------------
app.post('/vote', (req, res) => {
  const { email, voteDetails } = req.body;
  const data = readVotersData();
  const userIndex = data.votersPool.findIndex(u => u.email === email);
  if (userIndex === -1) {
    return res.status(400).json({ success: false, message: 'User not found' });
  }
  // Update vote for the match if it exists or add new vote
  const voteIndex = data.votersPool[userIndex].votingInfo.findIndex(info => info.matchName === voteDetails.matchName);
  if (voteIndex !== -1) {
    data.votersPool[userIndex].votingInfo[voteIndex] = voteDetails;
  } else {
    data.votersPool[userIndex].votingInfo.push(voteDetails);
  }
  writeVotersData(data);
  res.json({ success: true, message: 'Vote recorded successfully!' });
});

// ---------------------
// DECLARE WINNER & MOTM ENDPOINTS
// ---------------------
app.post('/declare-winner', (req, res) => {
  const { matchName, winner } = req.body;
  const resultsData = readResultsData();
  const index = resultsData.results.findIndex(r => r.matchName === matchName);
  if (index !== -1) {
    resultsData.results[index].winner = winner;
  } else {
    resultsData.results.push({ matchName, winner, declaredMotm: "" });
  }
  writeResultsData(resultsData);
  res.json({ success: true, message: "Winner declared successfully!" });
});

app.post('/declare-motm', (req, res) => {
  const { matchName, declaredMotm } = req.body;
  const resultsData = readResultsData();
  const index = resultsData.results.findIndex(r => r.matchName === matchName);
  if (index !== -1) {
    resultsData.results[index].declaredMotm = declaredMotm;
  } else {
    resultsData.results.push({ matchName, winner: "", declaredMotm });
  }
  writeResultsData(resultsData);
  res.json({ success: true, message: "Man of the Match declared successfully!" });
});

// ---------------------
// MATCH CANCELLED ENDPOINT
// ---------------------
app.post('/match-cancelled', (req, res) => {
  const { matchName } = req.body;
  const resultsData = readResultsData();
  const index = resultsData.results.findIndex(r => r.matchName === matchName);
  if (index !== -1) {
    resultsData.results[index].cancelled = true;
  } else {
    resultsData.results.push({ matchName, cancelled: true });
  }
  writeResultsData(resultsData);
  res.json({ success: true, message: "Match cancelled. No financial updates will be applied." });
});

// ---------------------
// FINALIZE MATCH ENDPOINT
// ---------------------
app.post('/finalize-match', (req, res) => {
  const { matchName } = req.body;
  const resultsData = readResultsData();
  const matchResult = resultsData.results.find(r => r.matchName === matchName);

  // If the match is cancelled, do not update financials.
  if (matchResult && matchResult.cancelled) {
    return res.json({ success: true, message: "Match cancelled. No financial updates." });
  }

  // Check if the match has already been finalized
  if (matchResult && matchResult.finalized) {
    return res.json({ success: true, message: "Match already finalized. No further updates applied." });
  }

  // Ensure that match result is fully declared
  if (!matchResult || !matchResult.winner || !matchResult.declaredMotm) {
    return res.status(400).json({ success: false, message: 'Match result not fully declared yet' });
  }

  const votersData = readVotersData();
  // Assume every voter has same contributions
  const sample = votersData.votersPool[0];
  const perMatchContri = sample.perMatchContri;
  const perMotmContri = sample.perMotmContri;

  // -------------------------
  // TEAM PREDICTION CALC
  // -------------------------
  const winningVoters = votersData.votersPool.filter(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    return vote && vote.votedTeam === matchResult.winner;
  });
  const losingVoters = votersData.votersPool.filter(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    return !vote || vote.votedTeam !== matchResult.winner;
  });

  const countWinning = winningVoters.length;
  const countLosing = losingVoters.length;
  const totalDeductionTeam = countLosing * perMatchContri;
  const bonusTeam = (countWinning > 0) ? (totalDeductionTeam / countWinning) : 0;

  // -------------------------
  // MOTM PREDICTION CALC
  // -------------------------
  const primaryMotmWinners = votersData.votersPool.filter(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    if (!vote || !vote.motm) return false;
    const combined = [...(vote.motm.teamA || []), ...(vote.motm.teamB || [])].filter(sel => sel !== '');
    return combined.includes(matchResult.declaredMotm);
  });
  const useFallback = (primaryMotmWinners.length === 0);

  let motmWinningVoters = [];
  if (!useFallback) {
    motmWinningVoters = primaryMotmWinners;
  } else {
    // fallback => correct team = motm winner
    motmWinningVoters = votersData.votersPool.filter(voter => {
      const vote = voter.votingInfo.find(v => v.matchName === matchName);
      return vote && vote.votedTeam === matchResult.winner;
    });
  }

  const countCorrectMotm = motmWinningVoters.length;
  const totalVoters = votersData.votersPool.length;
  const countWrongMotm = totalVoters - countCorrectMotm;
  const totalDeductionMotm = countWrongMotm * perMotmContri;
  const bonusMotm = (countCorrectMotm > 0) ? (totalDeductionMotm / countCorrectMotm) : 0;

  // -------------------------
  // UPDATE VOTER FINANCIALS
  // -------------------------
  votersData.votersPool = votersData.votersPool.map(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);

    // TEAM:
    if (vote && vote.votedTeam === matchResult.winner) {
      voter.currentStanding += bonusTeam;
    } else {
      voter.currentStanding -= perMatchContri;
    }

    // MOTM:
    if (!vote || !vote.motm) {
      voter.currentStanding -= perMotmContri;
    } else {
      let combined = [...(vote.motm.teamA || []), ...(vote.motm.teamB || [])].filter(sel => sel !== '');
      let isWinner = false;
      if (!useFallback) {
        isWinner = combined.includes(matchResult.declaredMotm);
      } else {
        isWinner = (vote.votedTeam === matchResult.winner);
      }

      if (isWinner) {
        voter.currentStanding += bonusMotm;
      } else {
        voter.currentStanding -= perMotmContri;
      }
    }
    return voter;
  });

  writeVotersData(votersData);

  // Mark as finalized
  if (matchResult) {
    matchResult.finalized = true;
  } else {
    resultsData.results.push({ matchName, winner: "", declaredMotm: "", finalized: true });
  }
  writeResultsData(resultsData);

  res.json({ success: true, message: 'Financials updated successfully', voters: votersData.votersPool });
});

// ---------------------
// DATA FETCH ENDPOINTS
// ---------------------
app.get('/voters', (req, res) => {
  const data = readVotersData();
  data.votersPool = data.votersPool.map(v => {
    const { password, ...rest } = v;
    return rest;
  });
  res.json(data);
});

app.get('/results', (req, res) => {
  res.json(readResultsData());
});

// ---------------------
// MATCHES ENDPOINT
// ---------------------
app.get('/matches', (req, res) => {
  try {
    res.json(readMatchesData());
  } catch (err) {
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

// ---------------------
// VOTE-STATS ENDPOINT
// ---------------------
app.get('/vote-stats', (req, res) => {
  const matchName = req.query.matchName;
  if (!matchName) {
    return res.status(400).json({ success: false, message: 'matchName query parameter is required' });
  }

  const data = readVotersData();
  const teamVotes = {};
  const motmVotes = {};

  data.votersPool.forEach(voter => {
    const vote = voter.votingInfo.find(v => v.matchName === matchName);
    if (vote) {
      if (vote.votedTeam) {
        teamVotes[vote.votedTeam] = (teamVotes[vote.votedTeam] || 0) + 1;
      }
      if (vote.motm) {
        const allMotm = [...(vote.motm.teamA || []), ...(vote.motm.teamB || [])];
        allMotm.forEach(candidate => {
          if (candidate && candidate.trim() !== "") {
            motmVotes[candidate] = (motmVotes[candidate] || 0) + 1;
          }
        });
      }
    }
  });

  const totalVoters = data.votersPool.length;
  res.json({ success: true, teamVotes, motmVotes, totalVoters });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
