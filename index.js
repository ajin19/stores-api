const express = require('express');
const bodyParser = require('body-parser');
const xml2js = require('xml2js');
const js2xmlparser = require('js2xmlparser');
const db = require('./db');
const helmet = require('helmet');
const cors = require('cors');
const { body, validationResult } = require('express-validator');

const app = express();
app.use(helmet());
app.use(cors());

// parse JSON
app.use(bodyParser.json({ limit: '1mb' }));

// parse text for XML
app.use(bodyParser.text({ type: ['application/xml', 'text/xml'], limit: '1mb' }));

// helper: parse incoming XML text to JS object if content-type is XML
async function parseIfXml(req, res, next) {
  if (req.is('application/xml') || req.is('text/xml')) {
    try {
      const xml = req.body || '';
      if (!xml.trim()) {
        req.body = {};
        return next();
      }
      const parser = new xml2js.Parser({ explicitArray: false, explicitRoot: false });
      const result = await parser.parseStringPromise(xml);
      // For convenience, if user sends <store><name>..</name></store>, map to req.body
      req.body = result;
      return next();
    } catch (err) {
      return res.status(400).json({ error: 'Invalid XML payload', details: err.message });
    }
  } else {
    // bodyParser.json already did parsing
    return next();
  }
}
app.use(parseIfXml);

// helper: send response in xml if Accept header requests xml
function sendResponse(req, res, data, status=200) {
  const accept = req.headers.accept || '';
  if (accept.includes('application/xml') || accept.includes('text/xml')) {
    // wrap arrays inside root
    const rootName = Array.isArray(data) ? 'stores' : (data && data.id ? 'store' : 'response');
    // convert data
    return res.status(status).type('application/xml').send(js2xmlparser.parse(rootName, data || {}));
  } else {
    return res.status(status).json(data);
  }
}

// --- CRUD Endpoints for /stores --- //

// 1. GET /stores - fetch all
app.get('/stores', (req, res) => {
  db.all('SELECT * FROM stores ORDER BY id DESC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    sendResponse(req, res, { store: rows }, 200);
  });
});

// 2. POST /stores - add a new store
app.post('/stores',
  // validation chain (works for JSON; for XML ensure fields present)
  body('name').notEmpty().withMessage('name is required'),
  body('address').notEmpty().withMessage('address is required'),
  async (req, res) => {
    // For XML requests, fields might be nested. Normalize common cases:
    // If req.body.store exists, use it.
    let payload = req.body;
    if (payload && payload.store) payload = payload.store;

    // If express-validator checks expect req.body, set it
    req.body = payload;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { name, address, phone = null, email = null } = payload;
    const stmt = db.prepare('INSERT INTO stores (name, address, phone, email) VALUES (?, ?, ?, ?)');
    stmt.run([name, address, phone, email], function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to create store' });
      }
      const newId = this.lastID;
      db.get('SELECT * FROM stores WHERE id = ?', [newId], (err2, row) => {
        if (err2) {
          console.error(err2);
          return res.status(500).json({ error: 'DB fetch failed' });
        }
        sendResponse(req, res, row, 201);
      });
    });
  }
);

// 3. GET /stores/:id - fetch store by id
app.get('/stores/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM stores WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!row) return res.status(404).json({ error: 'Store not found' });
    sendResponse(req, res, row, 200);
  });
});

// 4. PUT /stores/:id - update store by id (partial update allowed)
app.put('/stores/:id',
  // optional validation: name and address if present must be non-empty
  body('name').optional().notEmpty().withMessage('name cannot be empty'),
  body('address').optional().notEmpty().withMessage('address cannot be empty'),
  async (req, res) => {
    const id = Number(req.params.id);
    let payload = req.body;
    if (payload && payload.store) payload = payload.store;
    req.body = payload;

    // check if exists
    db.get('SELECT * FROM stores WHERE id = ?', [id], (err, existing) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: 'DB error' });
      }
      if (!existing) return res.status(404).json({ error: 'Store not found' });

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // merge
      const name = payload.name !== undefined ? payload.name : existing.name;
      const address = payload.address !== undefined ? payload.address : existing.address;
      const phone = payload.phone !== undefined ? payload.phone : existing.phone;
      const email = payload.email !== undefined ? payload.email : existing.email;

      db.run(
        `UPDATE stores SET name = ?, address = ?, phone = ?, email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [name, address, phone, email, id],
        function (updateErr) {
          if (updateErr) {
            console.error(updateErr);
            return res.status(500).json({ error: 'Update failed' });
          }
          db.get('SELECT * FROM stores WHERE id = ?', [id], (err2, row) => {
            if (err2) {
              console.error(err2);
              return res.status(500).json({ error: 'Fetch after update failed' });
            }
            sendResponse(req, res, row, 200);
          });
        }
      );
    });
  }
);

// 5. DELETE /stores/:id - delete store
app.delete('/stores/:id', (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM stores WHERE id = ?', [id], (err, row) => {
    if (err) { console.error(err); return res.status(500).json({ error: 'DB error' }); }
    if (!row) return res.status(404).json({ error: 'Store not found' });
    db.run('DELETE FROM stores WHERE id = ?', [id], function(delErr) {
      if (delErr) { console.error(delErr); return res.status(500).json({ error: 'Delete failed' }); }
      sendResponse(req, res, { message: 'Store deleted' }, 200);
    });
  });
});

// Health
app.get('/', (req,res) => {
  res.send('Stores API is running. Use /stores endpoint. Accepts JSON and XML.');
});

// Error fallback
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stores API listening on port ${PORT}`);
});
// index.js full code as provided in instructions; paste manually if needed.
