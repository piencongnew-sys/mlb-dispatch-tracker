const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_API = 'https://mlb-dashboard-r0za.onrender.com';

// Data file for dispatch tracking
const DATA_FILE = path.join(__dirname, 'dispatch-data.json');

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer setup for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `photo-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ============================================================
// DATA HELPERS
// ============================================================

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { slots: {}, dispatched: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { slots: {}, dispatched: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// API ROUTES
// ============================================================

// Proxy packing list from existing dashboard
app.get('/api/packing-list', async (req, res) => {
  try {
    const response = await fetch(`${DASHBOARD_API}/api/packing-list`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ success: false, error: 'Could not fetch packing list: ' + err.message });
  }
});

// Get all dispatch data (slot assignments + statuses)
app.get('/api/dispatch', (req, res) => {
  const data = loadData();
  res.json({ success: true, ...data });
});

// Assign order to parking slot
app.post('/api/dispatch/assign', upload.array('photos', 5), (req, res) => {
  const { invoiceNumber, slot, packedBy, boxes, remarks } = req.body;

  if (!invoiceNumber || !slot) {
    return res.json({ success: false, error: 'Invoice number and slot are required' });
  }

  const data = loadData();

  // Check if slot is already occupied by a different order
  const existingOrder = Object.entries(data.slots).find(
    ([inv, s]) => s.slot === slot && inv !== invoiceNumber && !data.dispatched[inv]
  );
  if (existingOrder) {
    return res.json({ success: false, error: `Slot ${slot} is already occupied by order ${existingOrder[0]}` });
  }

  // Build photo URLs
  const photos = (req.files || []).map(f => `/uploads/${f.filename}`);

  data.slots[invoiceNumber] = {
    slot,
    packedBy: packedBy || '',
    boxes: boxes || '',
    remarks: remarks || '',
    photos,
    assignedAt: new Date().toISOString()
  };

  // Remove from dispatched if re-assigning
  delete data.dispatched[invoiceNumber];

  saveData(data);
  res.json({ success: true });
});

// Mark order as dispatched
app.post('/api/dispatch/confirm', (req, res) => {
  const { invoiceNumber, driver } = req.body;
  if (!invoiceNumber) return res.json({ success: false, error: 'Invoice number required' });
  if (!driver) return res.json({ success: false, error: 'Please select a driver' });

  const data = loadData();
  if (!data.slots[invoiceNumber]) {
    return res.json({ success: false, error: 'Order not found in any parking slot' });
  }

  data.dispatched[invoiceNumber] = {
    dispatchedAt: new Date().toISOString(),
    slot: data.slots[invoiceNumber].slot,
    driver: driver
  };

  saveData(data);
  res.json({ success: true });
});

// Undo dispatch (move back to pending)
app.post('/api/dispatch/undo', (req, res) => {
  const { invoiceNumber } = req.body;
  if (!invoiceNumber) return res.json({ success: false, error: 'Invoice number required' });

  const data = loadData();
  delete data.dispatched[invoiceNumber];
  saveData(data);
  res.json({ success: true });
});

// Remove order from slot (clear slot)
app.post('/api/dispatch/remove', (req, res) => {
  const { invoiceNumber } = req.body;
  if (!invoiceNumber) return res.json({ success: false, error: 'Invoice number required' });

  const data = loadData();
  delete data.slots[invoiceNumber];
  delete data.dispatched[invoiceNumber];
  saveData(data);
  res.json({ success: true });
});

// ============================================================
// ROUTE PLANNING (OneMap geocoding + clustering)
// ============================================================

// Geocode cache to avoid repeated API calls
const GEO_CACHE_FILE = path.join(__dirname, 'geocache.json');

function loadGeoCache() {
  if (!fs.existsSync(GEO_CACHE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveGeoCache(cache) {
  fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function geocodeAddress(address) {
  const cache = loadGeoCache();

  // Extract postal code if present (6 digits)
  const postalMatch = address.match(/\b(\d{6})\b/);
  const searchKey = postalMatch ? postalMatch[1] : address.replace(/\n/g, ' ').trim();
  const cacheKey = searchKey.toLowerCase();

  if (cache[cacheKey]) return cache[cacheKey];

  try {
    const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(searchKey)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      const r = data.results[0];
      const result = {
        lat: parseFloat(r.LATITUDE),
        lng: parseFloat(r.LONGITUDE),
        address: r.ADDRESS,
        postal: r.POSTAL
      };
      cache[cacheKey] = result;
      saveGeoCache(cache);
      return result;
    }
  } catch (err) {
    console.error('Geocode error:', err.message);
  }
  return null;
}

// Haversine distance in km
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Simple greedy clustering: group orders within maxDist km of each other
function clusterOrders(geocoded, maxDist = 5) {
  const used = new Set();
  const clusters = [];

  // Sort by latitude (north to south) for consistent ordering
  const sorted = [...geocoded].sort((a, b) => b.lat - a.lat);

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(sorted[i].invoice)) continue;

    const cluster = [sorted[i]];
    used.add(sorted[i].invoice);

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(sorted[j].invoice)) continue;
      // Check distance to any point in cluster
      const nearAny = cluster.some(c =>
        haversine(c.lat, c.lng, sorted[j].lat, sorted[j].lng) <= maxDist
      );
      if (nearAny) {
        cluster.push(sorted[j]);
        used.add(sorted[j].invoice);
      }
    }

    // Sort within cluster for optimal delivery sequence (nearest neighbor)
    const ordered = [cluster[0]];
    const remaining = cluster.slice(1);
    while (remaining.length > 0) {
      const last = ordered[ordered.length - 1];
      let nearest = 0;
      let nearestDist = Infinity;
      for (let k = 0; k < remaining.length; k++) {
        const d = haversine(last.lat, last.lng, remaining[k].lat, remaining[k].lng);
        if (d < nearestDist) { nearestDist = d; nearest = k; }
      }
      ordered.push(remaining.splice(nearest, 1)[0]);
    }

    clusters.push(ordered);
  }

  return clusters;
}

// Singapore region name from postal prefix
function getRegion(postal) {
  if (!postal) return 'Unknown';
  const prefix = parseInt(postal.substring(0, 2));
  if (prefix >= 1 && prefix <= 8) return 'Central (CBD)';
  if (prefix >= 9 && prefix <= 16) return 'Central';
  if (prefix >= 17 && prefix <= 20) return 'Central East';
  if (prefix >= 21 && prefix <= 30) return 'Central South';
  if (prefix >= 31 && prefix <= 33) return 'North East';
  if (prefix >= 34 && prefix <= 37) return 'East';
  if (prefix >= 38 && prefix <= 41) return 'East';
  if (prefix >= 42 && prefix <= 45) return 'East';
  if (prefix >= 46 && prefix <= 48) return 'East';
  if (prefix >= 49 && prefix <= 52) return 'East';
  if (prefix >= 53 && prefix <= 55) return 'North East';
  if (prefix >= 56 && prefix <= 57) return 'North';
  if (prefix >= 58 && prefix <= 59) return 'Central North';
  if (prefix >= 60 && prefix <= 64) return 'West';
  if (prefix >= 65 && prefix <= 68) return 'North West';
  if (prefix >= 69 && prefix <= 71) return 'West';
  if (prefix >= 72 && prefix <= 73) return 'West';
  if (prefix >= 75 && prefix <= 76) return 'North';
  if (prefix >= 77 && prefix <= 78) return 'North';
  if (prefix >= 79 && prefix <= 80) return 'North East';
  if (prefix >= 81 && prefix <= 82) return 'East';
  return 'Other';
}

app.post('/api/routes/suggest', async (req, res) => {
  const { driverCount } = req.body;
  const numDrivers = parseInt(driverCount) || 3;

  const data = loadData();

  // Get assigned but not yet dispatched orders
  const pendingInvoices = Object.keys(data.slots).filter(inv => !data.dispatched[inv]);

  if (pendingInvoices.length === 0) {
    return res.json({ success: true, routes: [], message: 'No orders in parking slots to route' });
  }

  // Fetch packing list for addresses
  let packingOrders = [];
  try {
    const packRes = await fetch(`${DASHBOARD_API}/api/packing-list`);
    const packData = await packRes.json();
    if (packData.success) packingOrders = packData.orders || [];
  } catch (err) {
    return res.json({ success: false, error: 'Could not fetch packing list' });
  }

  // Geocode all pending orders
  const geocoded = [];
  for (const inv of pendingInvoices) {
    const order = packingOrders.find(o => o.invoiceNumber === inv);
    if (!order || !order.deliveryAddress) continue;

    const geo = await geocodeAddress(order.deliveryAddress);
    if (geo) {
      geocoded.push({
        invoice: inv,
        company: order.company || '',
        address: order.deliveryAddress,
        deliveryDate: order.deliveryDate || '',
        slot: data.slots[inv].slot,
        lat: geo.lat,
        lng: geo.lng,
        postal: geo.postal,
        region: getRegion(geo.postal)
      });
    } else {
      // Couldn't geocode — add anyway with no coordinates
      geocoded.push({
        invoice: inv,
        company: order.company || '',
        address: order.deliveryAddress,
        deliveryDate: order.deliveryDate || '',
        slot: data.slots[inv].slot,
        lat: null, lng: null, postal: null,
        region: 'Unknown'
      });
    }
  }

  // Cluster geocoded orders
  const withCoords = geocoded.filter(g => g.lat !== null);
  const noCoords = geocoded.filter(g => g.lat === null);

  let clusters = clusterOrders(withCoords, 5);

  // Add ungeocodable orders as individual clusters
  noCoords.forEach(o => clusters.push([o]));

  // If we have more clusters than drivers, merge the smallest/closest ones
  while (clusters.length > numDrivers && clusters.length > 1) {
    // Find two closest clusters and merge
    let minDist = Infinity;
    let mergeA = 0, mergeB = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i].find(o => o.lat);
        const cj = clusters[j].find(o => o.lat);
        if (ci && cj) {
          const d = haversine(ci.lat, ci.lng, cj.lat, cj.lng);
          if (d < minDist) { minDist = d; mergeA = i; mergeB = j; }
        }
      }
    }
    clusters[mergeA] = [...clusters[mergeA], ...clusters[mergeB]];
    clusters.splice(mergeB, 1);
  }

  // Build route objects
  const routes = clusters.map((orders, i) => {
    const regions = [...new Set(orders.map(o => o.region).filter(r => r !== 'Unknown'))];
    const regionLabel = regions.length > 0 ? regions.join(' / ') : 'Unknown Area';
    return {
      routeIndex: i,
      label: regionLabel,
      suggestedDriver: `Driver ${i + 1}`,
      orders: orders,
      totalStops: orders.length
    };
  });

  res.json({ success: true, routes });
});

// Batch assign a route to a driver
app.post('/api/routes/assign', (req, res) => {
  const { invoices, driver } = req.body;
  if (!invoices || !driver) return res.json({ success: false, error: 'Invoices and driver required' });

  const data = loadData();
  invoices.forEach(inv => {
    if (data.slots[inv]) {
      data.dispatched[inv] = {
        dispatchedAt: new Date().toISOString(),
        slot: data.slots[inv].slot,
        driver: driver
      };
    }
  });
  saveData(data);
  res.json({ success: true });
});

// ============================================================
// EXPORT CSV
// ============================================================

app.get('/api/export/csv', async (req, res) => {
  const data = loadData();

  // Fetch packing list for order details
  let packingOrders = [];
  try {
    const packRes = await fetch(`${DASHBOARD_API}/api/packing-list`);
    const packData = await packRes.json();
    if (packData.success) packingOrders = packData.orders || [];
  } catch (err) {
    return res.status(500).send('Could not fetch packing list');
  }

  // Build rows for all orders that have been assigned to slots
  const rows = [];
  const allInvoices = Object.keys(data.slots);

  allInvoices.forEach(inv => {
    const slot = data.slots[inv];
    const dispatched = data.dispatched[inv];
    const order = packingOrders.find(o => o.invoiceNumber === inv);

    let status = 'In Parking Slot';
    let driver = '';
    let dispatchedAt = '';

    if (dispatched) {
      status = 'Dispatched';
      driver = dispatched.driver || '';
      dispatchedAt = dispatched.dispatchedAt
        ? new Date(dispatched.dispatchedAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })
        : '';
    }

    rows.push({
      invoiceNumber: inv,
      company: order ? order.company : '',
      contactPerson: order ? order.contactPerson : '',
      contactDetails: order ? order.contactDetails : '',
      deliveryDate: order ? order.deliveryDate : '',
      deliveryAddress: order ? (order.deliveryAddress || '').replace(/\n/g, ' ') : '',
      items: order ? (order.items || []).join('; ') : '',
      bags: order ? order.bags : '',
      remarks: order ? (order.remarks || '').replace(/\n/g, ' ') : '',
      parkingSlot: slot.slot || '',
      packedBy: slot.packedBy || '',
      boxes: slot.boxes || '',
      assignedAt: slot.assignedAt
        ? new Date(slot.assignedAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })
        : '',
      status: status,
      driver: driver,
      dispatchedAt: dispatchedAt
    });
  });

  // Also add unassigned orders
  packingOrders.forEach(o => {
    if (!data.slots[o.invoiceNumber]) {
      rows.push({
        invoiceNumber: o.invoiceNumber,
        company: o.company || '',
        contactPerson: o.contactPerson || '',
        contactDetails: o.contactDetails || '',
        deliveryDate: o.deliveryDate || '',
        deliveryAddress: (o.deliveryAddress || '').replace(/\n/g, ' '),
        items: (o.items || []).join('; '),
        bags: o.bags || '',
        remarks: (o.remarks || '').replace(/\n/g, ' '),
        parkingSlot: '',
        packedBy: '',
        boxes: '',
        assignedAt: '',
        status: 'Not Assigned',
        driver: '',
        dispatchedAt: ''
      });
    }
  });

  // CSV header
  const headers = [
    'Invoice Number', 'Company', 'Contact Person', 'Contact Details',
    'Delivery Date', 'Delivery Address', 'Items', 'Bags', 'Remarks',
    'Parking Slot', 'Packed By', 'Boxes', 'Assigned At',
    'Status', 'Driver', 'Dispatched At'
  ];

  const escapeCsv = (val) => {
    const s = String(val || '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  let csv = headers.map(escapeCsv).join(',') + '\n';
  rows.forEach(row => {
    csv += [
      row.invoiceNumber, row.company, row.contactPerson, row.contactDetails,
      row.deliveryDate, row.deliveryAddress, row.items, row.bags, row.remarks,
      row.parkingSlot, row.packedBy, row.boxes, row.assignedAt,
      row.status, row.driver, row.dispatchedAt
    ].map(escapeCsv).join(',') + '\n';
  });

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dispatch-report-${today}.csv"`);
  // Add BOM for Excel to recognize UTF-8
  res.send('\uFEFF' + csv);
});

// ============================================================
// DRIVER MASTER LIST (printable)
// ============================================================

app.get('/api/print/driver/:driver', async (req, res) => {
  const driverName = decodeURIComponent(req.params.driver);
  const data = loadData();

  // Find all orders dispatched to this driver
  const driverOrders = [];
  Object.entries(data.dispatched).forEach(([inv, d]) => {
    if (d.driver === driverName) {
      driverOrders.push({ invoice: inv, ...d, slot: d.slot || (data.slots[inv] && data.slots[inv].slot) || '' });
    }
  });

  // Also include assigned (not yet dispatched) orders if they were route-assigned
  // For now, only show dispatched orders assigned to this driver

  if (driverOrders.length === 0) {
    return res.send('<html><body><h1>No orders found for ' + driverName + '</h1></body></html>');
  }

  // Fetch packing list for order details
  let packingOrders = [];
  try {
    const packRes = await fetch(`${DASHBOARD_API}/api/packing-list`);
    const packData = await packRes.json();
    if (packData.success) packingOrders = packData.orders || [];
  } catch (err) {}

  const today = new Date().toLocaleDateString('en-SG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Singapore' });

  let totalBoxes = 0;
  const rows = driverOrders.map((d, i) => {
    const order = packingOrders.find(o => o.invoiceNumber === d.invoice);
    const slot = data.slots[d.invoice];
    const boxes = slot ? (parseInt(slot.boxes) || 0) : 0;
    totalBoxes += boxes;
    const address = order ? (order.deliveryAddress || '').replace(/\n/g, ', ') : '';
    const contact = order ? ((order.contactPerson || '') + (order.contactDetails ? ' (' + order.contactDetails + ')' : '')) : '';
    const items = order ? (order.items || []) : [];
    const remarks = order ? (order.remarks || '') : '';
    const bags = order ? (order.bags || '') : '';

    return { index: i + 1, invoice: d.invoice, company: order ? order.company : '', address, contact, slot: d.slot, boxes, items, remarks, bags, deliveryDate: order ? order.deliveryDate : '' };
  });

  const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Driver Master List - ${esc(driverName)}</title>
  <style>
    @page { size: A4; margin: 15mm; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 12px; color: #333; padding: 20px; }

    .print-btn {
      position: fixed; top: 16px; right: 16px;
      padding: 12px 24px; background: #8B4513; color: white;
      border: none; border-radius: 8px; font-size: 16px;
      font-weight: 600; cursor: pointer; z-index: 100;
    }

    .header-section {
      border-bottom: 3px solid #8B4513;
      padding-bottom: 12px; margin-bottom: 16px;
    }
    .header-section h1 { font-size: 22px; color: #8B4513; }
    .header-section .meta { font-size: 14px; color: #666; margin-top: 4px; }
    .header-section .summary {
      display: flex; gap: 30px; margin-top: 10px; font-size: 15px; font-weight: 600;
    }
    .header-section .summary span { color: #8B4513; }

    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th {
      background: #8B4513; color: white;
      padding: 8px 10px; text-align: left;
      font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td {
      padding: 8px 10px; border-bottom: 1px solid #ddd;
      vertical-align: top; font-size: 12px;
    }
    tr:nth-child(even) { background: #FFF8F0; }

    .stop-num {
      background: #8B4513; color: white;
      width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 12px;
    }
    .slot-badge {
      background: #E3F2FD; color: #1565C0;
      padding: 2px 8px; border-radius: 4px;
      font-weight: 700; font-size: 13px;
    }
    .items-list { font-size: 11px; color: #555; }
    .remarks { color: #D32F2F; font-weight: 600; font-size: 11px; }
    .bags { color: #6A1B9A; font-size: 11px; }

    .checkbox-col { width: 40px; text-align: center; }
    .checkbox { width: 18px; height: 18px; border: 2px solid #999; border-radius: 3px; display: inline-block; }

    .footer { margin-top: 20px; border-top: 2px solid #8B4513; padding-top: 10px; font-size: 11px; color: #666; }
    .sign-area { display: flex; gap: 60px; margin-top: 30px; }
    .sign-line { border-bottom: 1px solid #333; width: 200px; padding-bottom: 4px; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">Print</button>

  <div class="header-section">
    <h1>Driver Master List</h1>
    <div class="meta">${esc(today)}</div>
    <div class="summary">
      <div>Driver: <span>${esc(driverName)}</span></div>
      <div>Orders: <span>${rows.length}</span></div>
      <div>Total Boxes: <span>${totalBoxes}</span></div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:35px;">#</th>
        <th style="width:55px;">Slot</th>
        <th style="width:100px;">Invoice</th>
        <th>Customer / Contact</th>
        <th>Delivery Address</th>
        <th style="width:50px;">Boxes</th>
        <th>Items / Remarks</th>
        <th class="checkbox-col">✓</th>
      </tr>
    </thead>
    <tbody>`;

  rows.forEach(r => {
    const itemsHtml = r.items.slice(0, 4).map(esc).join('<br>') + (r.items.length > 4 ? '<br><em>+' + (r.items.length - 4) + ' more</em>' : '');

    html += `
      <tr>
        <td><div class="stop-num">${r.index}</div></td>
        <td><span class="slot-badge">${esc(r.slot)}</span></td>
        <td><strong>${esc(r.invoice)}</strong></td>
        <td><strong>${esc(r.company)}</strong><br><span style="font-size:11px;color:#666;">${esc(r.contact)}</span></td>
        <td style="font-size:11px;">${esc(r.address)}</td>
        <td style="text-align:center;font-size:16px;font-weight:700;">${r.boxes}</td>
        <td>
          <div class="items-list">${itemsHtml}</div>
          ${r.bags && r.bags !== '-' && r.bags.toLowerCase() !== 'no' ? '<div class="bags">Bags: ' + esc(r.bags) + '</div>' : ''}
          ${r.remarks ? '<div class="remarks">⚠ ' + esc(r.remarks.replace(/\n/g, ' ')) + '</div>' : ''}
        </td>
        <td class="checkbox-col"><div class="checkbox"></div></td>
      </tr>`;
  });

  html += `
    </tbody>
  </table>

  <div class="footer">
    <div class="sign-area">
      <div>
        <div class="sign-line">Driver Signature</div>
      </div>
      <div>
        <div class="sign-line">Warehouse Sign-off</div>
      </div>
      <div>
        <div class="sign-line">Time Out</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dispatch Tracker running on http://localhost:${PORT}`);
  console.log(`Mobile access: http://192.168.10.97:${PORT}`);
});
