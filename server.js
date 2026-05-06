const express = require('express');
const mysql = require('mysql2/promise');
const pool = require('./models/db');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

/**
 * UTILS
 */
async function getOrInsert(table, nom) {
    if (!nom) return null;
    const cleanNom = nom.trim();
    const [rows] = await pool.execute(`SELECT id FROM ${table} WHERE nom = ?`, [cleanNom]);
    if (rows.length > 0) return rows[0].id;
    const [result] = await pool.execute(`INSERT INTO ${table} (nom) VALUES (?)`, [cleanNom]);
    return result.insertId;
}

/**
 * ROUTES
 */

// 1. RÉCUPÉRATION
app.get('/api/parfums', async (req, res) => {
    try {
        const sql = `
    SELECT p.*, 
    COALESCE(m.nom, '') as maison,
    COALESCE((SELECT GROUP_CONCAT(f.nom) FROM parfums_familles pf JOIN familles f ON pf.famille_id = f.id WHERE pf.parfum_id = p.id), '') as familles,
    COALESCE((SELECT GROUP_CONCAT(s.nom) FROM parfums_saisons ps JOIN saisons s ON ps.saison_id = s.id WHERE ps.parfum_id = p.id), '') as saisons,
    COALESCE((SELECT GROUP_CONCAT(b.nom) FROM parfums_boutiques pb JOIN boutiques b ON pb.boutique_id = b.id WHERE pb.parfum_id = p.id), '') as dispo,
    COALESCE((SELECT GROUP_CONCAT(n.nom) FROM parfums_notes pn JOIN notes n ON pn.note_id = n.id WHERE pn.parfum_id = p.id AND pn.type = 'tête'), '') as notes_tete,
    COALESCE((SELECT GROUP_CONCAT(n.nom) FROM parfums_notes pn JOIN notes n ON pn.note_id = n.id WHERE pn.parfum_id = p.id AND pn.type = 'coeur'), '') as notes_coeur,
    COALESCE((SELECT GROUP_CONCAT(n.nom) FROM parfums_notes pn JOIN notes n ON pn.note_id = n.id WHERE pn.parfum_id = p.id AND pn.type = 'fond'), '') as notes_fond,
    COALESCE((SELECT GROUP_CONCAT(n.nom) FROM parfums_notes pn JOIN notes n ON pn.note_id = n.id WHERE pn.parfum_id = p.id), '') as all_notes,
    IF(fav.id IS NULL, 0, 1) as is_favorite,
    IF(pos.id IS NULL, 0, 1) as is_owned
    FROM parfums p
    LEFT JOIN maisons m ON p.maison_id = m.id
    LEFT JOIN favoris fav ON p.id = fav.parfum_id
    LEFT JOIN possedes pos ON p.id = pos.parfum_id
    ORDER BY maison
`;
        const [rows] = await pool.query(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Basculer l'état favori (Toggle)
app.post('/api/favoris/:id', async (req, res) => {
    try {
        const [existing] = await pool.execute('SELECT id FROM favoris WHERE parfum_id = ?', [req.params.id]);
        if (existing.length > 0) {
            await pool.execute('DELETE FROM favoris WHERE parfum_id = ?', [req.params.id]);
            res.json({ is_favorite: false });
        } else {
            await pool.execute('INSERT INTO favoris (parfum_id) VALUES (?)', [req.params.id]);
            res.json({ is_favorite: true });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Basculer l'état possédé (Toggle)
app.post('/api/possedes/:id', async (req, res) => {
    try {
        const [existing] = await pool.execute('SELECT id FROM possedes WHERE parfum_id = ?', [req.params.id]);
        if (existing.length > 0) {
            await pool.execute('DELETE FROM possedes WHERE parfum_id = ?', [req.params.id]);
            res.json({ is_owned: false });
        } else {
            await pool.execute('INSERT INTO possedes (parfum_id) VALUES (?)', [req.params.id]);
            res.json({ is_owned: true });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. AJOUT
app.post('/api/parfums', async (req, res) => {
    const { reference, maison, prix, taille, image_url, familles, saisons, tete, coeur, fond, dispo } = req.body;
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const maisonId = await getOrInsert('maisons', maison);

        const [pResult] = await conn.execute(
            `INSERT INTO parfums (reference, prix, taille, image_url, maison_id) VALUES (?, ?, ?, ?, ?)`,
            [reference, parseInt(prix) || 0, taille || '', image_url || '', maisonId]
        );
        const parfumId = pResult.insertId;

        const insertPivots = async (data, tableRef, tablePivot) => {
            if (!data) return;
            const items = typeof data === 'string' ? data.split(',') : data;
            for (let item of items) {
                if (item.trim()) {
                    const idRef = await getOrInsert(tableRef, item.trim());
                    if (idRef) await conn.execute(`INSERT IGNORE INTO ${tablePivot} VALUES (?, ?)`, [parfumId, idRef]);
                }
            }
        };

        await insertPivots(familles, 'familles', 'parfums_familles');
        await insertPivots(saisons, 'saisons', 'parfums_saisons');
        await insertPivots(dispo, 'boutiques', 'parfums_boutiques');

        const notesObj = { tête: tete, coeur: coeur, fond: fond };
        for (const [type, str] of Object.entries(notesObj)) {
            if (str) {
                for (let n of str.split(',')) {
                    if (n.trim()) {
                        const nId = await getOrInsert('notes', n.trim());
                        await conn.execute(`INSERT IGNORE INTO parfums_notes VALUES (?, ?, ?)`, [parfumId, nId, type]);
                    }
                }
            }
        }

        await conn.commit();
        res.json({ success: true, id: parfumId });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

// 3. MODIFICATION
app.put('/api/parfums/:id', async (req, res) => {
    const { id } = req.params;
    const { reference, maison, prix, taille, image_url, tete, coeur, fond, dispo, saisons } = req.body;
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const maisonId = await getOrInsert('maisons', maison);
        await conn.execute(
            `UPDATE parfums SET reference = ?, prix = ?, taille = ?, image_url = ?, maison_id = ? WHERE id = ?`,
            [reference, parseInt(prix) || 0, taille || '', image_url || '', maisonId, id]
        );

        await conn.execute(`DELETE FROM parfums_notes WHERE parfum_id = ?`, [id]);
        await conn.execute(`DELETE FROM parfums_boutiques WHERE parfum_id = ?`, [id]);
        await conn.execute(`DELETE FROM parfums_saisons WHERE parfum_id = ?`, [id]);

        if (dispo) {
            const shops = typeof dispo === 'string' ? dispo.split(',') : dispo;
            for (let s of shops) {
                if (s.trim()) {
                    const bId = await getOrInsert('boutiques', s.trim());
                    await conn.execute(`INSERT INTO parfums_boutiques VALUES (?, ?)`, [id, bId]);
                }
            }
        }

        if (saisons) {
            const seas = typeof saisons === 'string' ? saisons.split(',') : saisons;
            for (let s of seas) {
                if (s.trim()) {
                    const sId = await getOrInsert('saisons', s.trim());
                    await conn.execute(`INSERT INTO parfums_saisons VALUES (?, ?)`, [id, sId]);
                }
            }
        }

        const notesObj = { tête: tete, coeur: coeur, fond: fond };
        for (const [type, str] of Object.entries(notesObj)) {
            if (str) {
                for (let n of str.split(',')) {
                    if (n.trim()) {
                        const nId = await getOrInsert('notes', n.trim());
                        await conn.execute(`INSERT INTO parfums_notes VALUES (?, ?, ?)`, [id, nId, type]);
                    }
                }
            }
        }

        await conn.commit();
        res.json({ success: true });
    } catch (err) {
        await conn.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

// 4. SUPPRESSION
app.delete('/api/parfums/:id', async (req, res) => {
    try {
        await pool.execute(`DELETE FROM parfums WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ScentVault Backend : http://localhost:${PORT}`));