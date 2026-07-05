// ================= IMPORTS =================
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// ================= CONFIGURATION =================
const app = express();
const PORT = process.env.PORT || 3000;

const WEEKLY_FEE = 1000;

const DATABASE_URL = process.env.DATABASE_URL;
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // In case you add CSS later

app.use(session({
    secret: crypto.randomBytes(24).toString('hex'), 
    resave: false,
    saveUninitialized: false
}));

// ================= DATABASE SETUP =================
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS renters (id SERIAL PRIMARY KEY, name TEXT, phone TEXT, address TEXT, start_date TEXT, due_date TEXT, paid TEXT, last_payment_date TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, renter_id INTEGER, amount INTEGER, payment_date TEXT)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT, password TEXT)`);

        const userRes = await pool.query("SELECT * FROM users WHERE username = $1", ["admin"]);
        if (userRes.rows.length === 0) {
            const hashed = await bcrypt.hash("1234", 10);
            await pool.query("INSERT INTO users (username, password) VALUES ($1, $2)", ["admin", hashed]);
        }
        console.log("✅ Database initialized successfully!");
    } catch (err) {
        console.error("❌ Error initializing database:", err);
    }
}
initDB();

// ================= DATE & LOGIC HELPERS =================

// Helper to format date as YYYY-MM-DD
function formatDate(date) {
    const d = new Date(date);
    let month = '' + (d.getMonth() + 1);
    let day = '' + d.getDate();
    const year = d.getFullYear();
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return [year, month, day].join('-');
}

// Get Wednesday to Tuesday range
function getWeekRange(dateInput) {
    const today = new Date(dateInput);
    const dayOfWeek = today.getDay(); // 0 = Sun, 3 = Wed
    const daysSinceWed = (dayOfWeek + 7 - 3) % 7;
    
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - daysSinceWed);
    
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    
    return { weekStart, weekEnd };
}

// Calculate debt and due status
async function getStatus(renter_id, start_date_str) {
    const today = new Date();
    const { weekStart, weekEnd } = getWeekRange(today);
    
    // Days left
    const timeDiff = weekEnd.getTime() - today.getTime();
    let daysLeft = Math.ceil(timeDiff / (1000 * 3600 * 24));
    if (daysLeft < 0) daysLeft = 0;
    const dueInfo = `Due in ${daysLeft} days`;
    
    // Total paid
    const paidRes = await pool.query("SELECT SUM(amount) FROM payments WHERE renter_id=$1", [renter_id]);
    const totalPaid = Number(paidRes.rows[0].sum || 0);
    
    // Weeks passed
    const startDate = new Date(start_date_str);
    const { weekStart: startWeekStart } = getWeekRange(startDate);
    const msPassed = weekStart.getTime() - startWeekStart.getTime();
    let weeksPassed = Math.floor(msPassed / (1000 * 3600 * 24 * 7)) + 1;
    if (weeksPassed < 1) weeksPassed = 1;
    
    const expected = weeksPassed * WEEKLY_FEE;
    let debt = expected - totalPaid;
    if (debt < 0) debt = 0;
    
    return { dueInfo, debt };
}

// ================= MIDDLEWARE =================
// Protects routes from unauthenticated users
function requireAuth(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
}

// ================= ROUTES =================

app.get('/', (req, res) => {
    res.redirect('/login');
});

// LOGIN / LOGOUT
app.route('/login')
    .get((req, res) => res.render('login'))
    .post(async (req, res) => {
        const { username, password } = req.body;
        const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
        const user = result.rows[0];
        
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = username;
            res.redirect('/home');
        } else {
            res.send("❌ Invalid credentials");
        }
    });

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// HOME
app.get('/home', requireAuth, (req, res) => {
    res.render('home');
});

// ADD RENTER
app.route('/add')
    .get(requireAuth, (req, res) => res.render('add'))
    .post(requireAuth, async (req, res) => {
        const { name, phone, address } = req.body;
        const today = new Date();
        const dueDate = new Date(today);
        dueDate.setDate(today.getDate() + 7);

        await pool.query(`
            INSERT INTO renters (name, phone, address, start_date, due_date)
            VALUES ($1, $2, $3, $4, $5)
        `, [name, phone, address, formatDate(today), formatDate(dueDate)]);
        
        res.redirect('/dashboard');
    });

// DASHBOARD
app.get('/dashboard', requireAuth, async (req, res) => {
    const filterType = req.query.filter;
    const search = req.query.search || "";
    
    let query = "SELECT * FROM renters";
    let params = [];
    if (search) {
        query += " WHERE name ILIKE $1 OR phone ILIKE $1 OR address ILIKE $1";
        params = [`%${search}%`];
    }
    
    const result = await pool.query(query, params);
    let renters = result.rows;
    
    let updated = [];
    let paidCount = 0;
    let lateCount = 0;
    
    for (let r of renters) {
        const { dueInfo, debt } = await getStatus(r.id, r.start_date);
        let status = debt > 0 ? "late" : "paid";
        if (status === "late") lateCount++;
        else paidCount++;
        
        // Spread the database row and add our computed fields
        updated.push({ ...r, dueInfo, debt, status });
    }
    
    if (filterType === "paid") updated = updated.filter(r => r.status === "paid");
    if (filterType === "overdue") updated = updated.filter(r => r.status === "late");

    res.render('index', { renters: updated, total: renters.length, paid: paidCount, overdue: lateCount });
});

// RENTERS
app.get('/renters', requireAuth, async (req, res) => {
    const result = await pool.query("SELECT * FROM renters");
    let updated = [];
    for (let r of result.rows) {
        const { dueInfo, debt } = await getStatus(r.id, r.start_date);
        updated.push({ ...r, dueInfo, debt });
    }
    res.render('renters', { renters: updated });
});

// MONEY
app.get('/money', requireAuth, async (req, res) => {
    const rentersRes = await pool.query("SELECT * FROM renters");
    let paid = 0;
    let late = 0;
    
    for (let r of rentersRes.rows) {
        const { debt } = await getStatus(r.id, r.start_date);
        if (debt > 0) late++;
        else paid++;
    }
    
    const paymentRes = await pool.query("SELECT SUM(amount) FROM payments");
    const collected = Number(paymentRes.rows[0].sum || 0);
    const expected = rentersRes.rows.length * WEEKLY_FEE;
    
    res.render('money', { 
        total_renters: rentersRes.rows.length, 
        paid_renters: paid, 
        overdue_renters: late, 
        weekly_fee: WEEKLY_FEE, 
        collected_money: collected, 
        expected_money: expected 
    });
});

// RENTER PROFILE
app.get('/renter/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const renterRes = await pool.query("SELECT * FROM renters WHERE id=$1", [id]);
    const renter = renterRes.rows[0];
    
    if (!renter) return res.send("Renter not found");
    
    const paymentRes = await pool.query("SELECT amount, payment_date FROM payments WHERE renter_id=$1 ORDER BY payment_date DESC", [id]);
    const payments = paymentRes.rows;
    
    const total_paid = payments.reduce((sum, p) => sum + p.amount, 0);
    const total_payments = payments.length;
    const last_payment = payments.length ? payments[0].payment_date : null;
    
    const { dueInfo, debt } = await getStatus(renter.id, renter.start_date);
    
    res.render('renter', { renter, payments, total_paid, total_payments, last_payment, dueInfo, debt });
});

// EDIT RENTER
app.route('/edit/:id')
    .get(requireAuth, async (req, res) => {
        const renter = (await pool.query("SELECT * FROM renters WHERE id=$1", [req.params.id])).rows[0];
        if (!renter) return res.send("Renter not found");
        res.render('edit', { renter });
    })
    .post(requireAuth, async (req, res) => {
        const { id } = req.params;
        const { name, phone, address, password } = req.body;
        
        const user = (await pool.query("SELECT password FROM users WHERE username=$1", [req.session.user])).rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) return res.send("❌ Wrong password");
        
        await pool.query("UPDATE renters SET name=$1, phone=$2, address=$3 WHERE id=$4", [name, phone, address, id]);
        res.redirect('/renters');
    });

// DELETE RENTER
app.route('/delete/:id')
    .get(requireAuth, async (req, res) => {
        const renter = (await pool.query("SELECT * FROM renters WHERE id=$1", [req.params.id])).rows[0];
        if (!renter) return res.send("Renter not found");
        res.render('confirm_delete', { renter });
    })
    .post(requireAuth, async (req, res) => {
        const { id } = req.params;
        const { password } = req.body;
        
        const user = (await pool.query("SELECT password FROM users WHERE username=$1", [req.session.user])).rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) return res.send("❌ Wrong password");
        
        await pool.query("DELETE FROM payments WHERE renter_id=$1", [id]);
        await pool.query("DELETE FROM renters WHERE id=$1", [id]);
        res.redirect('/renters');
    });

// PAY
app.route('/pay/:id')
    .get(requireAuth, async (req, res) => {
        const id = req.params.id;
        const renter = (await pool.query("SELECT * FROM renters WHERE id=$1", [id])).rows[0];
        if (!renter) return res.send("Renter not found");
        
        const today = new Date();
        const { weekStart, weekEnd } = getWeekRange(today);
        
        const already_paid_res = await pool.query(`
            SELECT * FROM payments WHERE renter_id=$1 AND payment_date BETWEEN $2 AND $3
        `, [id, formatDate(weekStart), formatDate(weekEnd)]);
        
        const { dueInfo, debt } = await getStatus(renter.id, renter.start_date);
        
        res.render('pay', { renter, debt, dueInfo, already_paid: already_paid_res.rows[0] });
    })
    .post(requireAuth, async (req, res) => {
        const { id } = req.params;
        const { password, amount } = req.body;
        
        const user = (await pool.query("SELECT password FROM users WHERE username=$1", [req.session.user])).rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) return res.send("❌ Wrong password");
        
        const renter = (await pool.query("SELECT * FROM renters WHERE id=$1", [id])).rows[0];
        const today = new Date();
        const { weekStart, weekEnd } = getWeekRange(today);
        
        const already_paid_res = await pool.query(`
            SELECT * FROM payments WHERE renter_id=$1 AND payment_date BETWEEN $2 AND $3
        `, [id, formatDate(weekStart), formatDate(weekEnd)]);
        const already_paid = already_paid_res.rows[0];
        
        const { debt } = await getStatus(renter.id, renter.start_date);
        const paymentAmount = amount ? parseInt(amount) : WEEKLY_FEE;
        
        if (debt === 0 && already_paid) return res.send("⚠ Nothing to pay (already paid)");
        
        await pool.query("INSERT INTO payments (renter_id, amount, payment_date) VALUES ($1, $2, $3)", [id, paymentAmount, formatDate(today)]);
        res.redirect('/renter/' + id);
    });

// PASSWORD MANAGEMENT
app.route('/verify-user')
    .get(requireAuth, (req, res) => res.render('verify_user', { message: "" }))
    .post(requireAuth, async (req, res) => {
        const { password } = req.body;
        const user = (await pool.query("SELECT password FROM users WHERE username=$1", [req.session.user])).rows[0];
        
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.verify_user = req.session.user;
            res.redirect('/new-password');
        } else {
            res.render('verify_user', { message: "❌ Incorrect password" });
        }
    });

app.route('/new-password')
    .get((req, res) => {
        if (!req.session.verify_user) return res.redirect('/verify-user');
        res.render('new_password', { message: "" });
    })
    .post(async (req, res) => {
        const { new_password, confirm_password } = req.body;
        if (new_password !== confirm_password) return res.send("❌ New passwords do not match");
        
        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query("UPDATE users SET password=$1 WHERE username=$2", [hashed, req.session.verify_user]);
        
        req.session.verify_user = null;
        res.send("✅ Password changed successfully");
    });

// ================= START SERVER =================
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});