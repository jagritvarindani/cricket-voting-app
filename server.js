// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'cricketvoting';
let db;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('Connected to MongoDB');

  // Seed voters if collection is empty
  const votersCount = await db.collection('voters').countDocuments();
  if (votersCount === 0) {
    const defaultVoters = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-defaults', 'votersPool.json'), 'utf8'));
    await db.collection('voters').insertMany(defaultVoters.votersPool);
    console.log('Seeded voters from defaults');
  }

  // Seed results if collection is empty
  const resultsCount = await db.collection('results').countDocuments();
  if (resultsCount === 0) {
    const defaultResults = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-defaults', 'matchResults.json'), 'utf8'));
    if (defaultResults.results && defaultResults.results.length > 0) {
      await db.collection('results').insertMany(defaultResults.results);
      console.log('Seeded results from defaults');
    }
  }
}

// ---------------------
// MATCHES ENDPOINT (read from file)
// ---------------------
app.get('/matches', (req, res) => {
  try {
    const matches = JSON.parse(fs.readFileSync(path.join(__dirname, 'matches.json'), 'utf8'));
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load matches' });
  }
});

// ---------------------
// LOGIN ENDPOINT
// ---------------------
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.collection('voters').findOne({ email, password });
  if (user) {
    const { password, _id, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.json({ success: false, message: 'Invalid credentials' });
  }
});

// ---------------------
// VOTING ENDPOINT
// ---------------------
app.post('/vote', async (req, res) => {
  const { email, voteDetails } = req.body;
  const user = await db.collection('voters').findOne({ email });
  if (!user) {
    return res.status(400).json({ success: false, message: 'User not found' });
  }

  const votingInfo = user.votingInfo || [];
  const voteIndex = votingInfo.findIndex(v => v.matchName === voteDetails.matchName);
  if (voteIndex !== -1) {
    votingInfo[voteIndex] = voteDetails;
  } else {
    votingInfo.push(voteDetails);
  }

  await db.collection('voters').updateOne({ email }, { $set: { votingInfo } });
  res.json({ success: true, message: 'Vote recorded successfully!' });
});

// ---------------------
// DECLARE WINNER
// ---------------------
app.post('/declare-winner', async (req, res) => {
  const { matchName, winner } = req.body;
  const existing = await db.collection('results').findOne({ matchName });
  if (existing) {
    await db.collection('results').updateOne({ matchName }, { $set: { winner } });
  } else {
    await db.collection('results').insertOne({ matchName, winner, declaredMotm: '' });
  }
  res.json({ success: true, message: 'Winner declared successfully!' });
});

// ---------------------
// DECLARE MOTM
// ---------------------
app.post('/declare-motm', async (req, res) => {
  const { matchName, declaredMotm } = req.body;
  const existing = await db.collection('results').findOne({ matchName });
  if (existing) {
    await db.collection('results').updateOne({ matchName }, { $set: { declaredMotm } });
  } else {
    await db.collection('results').insertOne({ matchName, winner: '', declaredMotm });
  }
  res.json({ success: true, message: 'Man of the Match declared successfully!' });
});

// ---------------------
// MATCH CANCELLED
// ---------------------
app.post('/match-cancelled', async (req, res) => {
  const { matchName } = req.body;
  const existing = await db.collection('results').findOne({ matchName });
  if (existing) {
    await db.collection('results').updateOne({ matchName }, { $set: { cancelled: true } });
  } else {
    await db.collection('results').insertOne({ matchName, cancelled: true });
  }
  res.json({ success: true, message: 'Match cancelled. No financial updates will be applied.' });
});

// ---------------------
// FINALIZE MATCH
// ---------------------
app.post('/finalize-match', async (req, res) => {
  const { matchName } = req.body;
  const matchResult = await db.collection('results').findOne({ matchName });

  if (matchResult && matchResult.cancelled) {
    return res.json({ success: true, message: 'Match cancelled. No financial updates.' });
  }
  if (matchResult && matchResult.finalized) {
    return res.json({ success: true, message: 'Match already finalized. No further updates applied.' });
  }
  if (!matchResult || !matchResult.winner || !matchResult.declaredMotm) {
    return res.status(400).json({ success: false, message: 'Match result not fully declared yet' });
  }

  const allVoters = await db.collection('voters').find({}).toArray();
  const sample = allVoters[0];
  const perMatchContri = sample.perMatchContri;
  const perMotmContri = sample.perMotmContri;

  // TEAM PREDICTION CALC
  const winningVoters = allVoters.filter(voter => {
    const vote = (voter.votingInfo || []).find(v => v.matchName === matchName);
    return vote && vote.votedTeam === matchResult.winner;
  });
  const countWinning = winningVoters.length;
  const countLosing = allVoters.length - countWinning;
  const totalDeductionTeam = countLosing * perMatchContri;
  const bonusTeam = countWinning > 0 ? totalDeductionTeam / countWinning : 0;

  // MOTM PREDICTION CALC
  const primaryMotmWinners = allVoters.filter(voter => {
    const vote = (voter.votingInfo || []).find(v => v.matchName === matchName);
    if (!vote || !vote.motm) return false;
    const combined = [...(vote.motm.teamA || []), ...(vote.motm.teamB || [])].filter(s => s !== '');
    return combined.includes(matchResult.declaredMotm);
  });
  const useFallback = primaryMotmWinners.length === 0;

  const motmWinningVoters = useFallback
    ? allVoters.filter(voter => {
        const vote = (voter.votingInfo || []).find(v => v.matchName === matchName);
        return vote && vote.votedTeam === matchResult.winner;
      })
    : primaryMotmWinners;

  const countCorrectMotm = motmWinningVoters.length;
  const countWrongMotm = allVoters.length - countCorrectMotm;
  const totalDeductionMotm = countWrongMotm * perMotmContri;
  const bonusMotm = countCorrectMotm > 0 ? totalDeductionMotm / countCorrectMotm : 0;

  // UPDATE VOTER FINANCIALS
  const bulkOps = allVoters.map(voter => {
    const vote = (voter.votingInfo || []).find(v => v.matchName === matchName);
    let standing = voter.currentStanding;

    // Team
    if (vote && vote.votedTeam === matchResult.winner) {
      standing += bonusTeam;
    } else {
      standing -= perMatchContri;
    }

    // MOTM
    if (!vote || !vote.motm) {
      standing -= perMotmContri;
    } else {
      const combined = [...(vote.motm.teamA || []), ...(vote.motm.teamB || [])].filter(s => s !== '');
      const isWinner = useFallback
        ? vote.votedTeam === matchResult.winner
        : combined.includes(matchResult.declaredMotm);
      if (isWinner) {
        standing += bonusMotm;
      } else {
        standing -= perMotmContri;
      }
    }

    return {
      updateOne: {
        filter: { email: voter.email },
        update: { $set: { currentStanding: standing } }
      }
    };
  });

  await db.collection('voters').bulkWrite(bulkOps);
  await db.collection('results').updateOne({ matchName }, { $set: { finalized: true } });

  const updatedVoters = await db.collection('voters').find({}).toArray();
  res.json({ success: true, message: 'Financials updated successfully', voters: updatedVoters });
});

// ---------------------
// DATA FETCH ENDPOINTS
// ---------------------
app.get('/voters', async (req, res) => {
  const voters = await db.collection('voters').find({}).toArray();
  const safe = voters.map(({ password, _id, ...rest }) => rest);
  res.json({ votersPool: safe });
});

app.get('/results', async (req, res) => {
  const results = await db.collection('results').find({}).toArray();
  const clean = results.map(({ _id, ...rest }) => rest);
  res.json({ results: clean });
});

// ---------------------
// VOTE-STATS ENDPOINT
// ---------------------
app.get('/vote-stats', async (req, res) => {
  const { matchName } = req.query;
  if (!matchName) {
    return res.status(400).json({ success: false, message: 'matchName query parameter is required' });
  }

  const voters = await db.collection('voters').find({}).toArray();
  const teamVotes = {};
  const motmVotes = {};

  voters.forEach(voter => {
    const vote = (voter.votingInfo || []).find(v => v.matchName === matchName);
    if (vote) {
      if (vote.votedTeam) {
        teamVotes[vote.votedTeam] = (teamVotes[vote.votedTeam] || 0) + 1;
      }
      if (vote.motm) {
        const allMotm = [...(vote.motm.teamA || []), ...(vote.motm.teamB || [])];
        allMotm.forEach(candidate => {
          if (candidate && candidate.trim() !== '') {
            motmVotes[candidate] = (motmVotes[candidate] || 0) + 1;
          }
        });
      }
    }
  });

  res.json({ success: true, teamVotes, motmVotes, totalVoters: voters.length });
});

// ---------------------
// START SERVER
// ---------------------
const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});
