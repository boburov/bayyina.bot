require('dotenv').config();
const express = require('express');
const { readDB, writeDB } = require('./db');
require('./bot'); // botni ishga tushirish

const app = express();
app.use(express.json());

app.get('/channels', (req, res) => {
    res.json(readDB().channels);
});

app.listen(5000, () => {
    console.log("✅ Server 5000-portda ishlamoqda");
});