// server.js
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Variables de entorno
const PORT = process.env.PORT || 3000;

// DB
const db = new sqlite3.Database('./db.sqlite');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS horas (
    hora TEXT PRIMARY KEY,
    estado TEXT DEFAULT 'disponible',
    nombre TEXT,
    expiracion INTEGER
  )`);

  const horas = ['10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30',
    '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30',
    '18:00','18:30','19:00','19:30','20:00','20:30'
  ];

  horas.forEach(hora => {
    db.run(`INSERT OR IGNORE INTO horas (hora) VALUES (?)`, [hora]);
  });
});

// Static + API
app.use(express.static(path.join(__dirname, 'public')));

app.get('/horas-reservadas', (req, res) => {
  db.all(`SELECT hora, nombre FROM horas WHERE estado = 'reservado'`, (err, filas) => {
    if (err) return res.status(500).json({ error: 'Error interno del servidor' });
    res.json(filas);
  });
});

// Limpieza periódica de pre-reservas expiradas
function limpiarExpiradas() {
  const ahora = Date.now();
  db.run(`UPDATE horas SET estado='disponible', expiracion=NULL, nombre=NULL 
          WHERE estado='pre-reservado' AND expiracion < ?`, [ahora]);
}
setInterval(limpiarExpiradas, 5000);

// WebSocket
const wss = new WebSocket.Server({ server });

function broadcast(tipo, hora, estado, nombre = '') {
  const mensaje = JSON.stringify({ tipo, hora, estado, nombre });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(mensaje);
    }
  });
}

function limpiarExpiradasYBroadcast(callback) {
  const ahora = Date.now();
  db.run(`UPDATE horas SET estado='disponible', expiracion=NULL, nombre=NULL 
          WHERE estado='pre-reservado' AND expiracion < ?`, [ahora], () => {
    db.all(`SELECT hora FROM horas WHERE estado = 'disponible' AND expiracion IS NULL`, (err, filas) => {
      filas?.forEach(fila => {
        broadcast('estado_actualizado', fila.hora, 'disponible');
      });
      callback?.();
    });
  });
}

function enviarEstadoInicial(ws) {
  limpiarExpiradasYBroadcast(() => {
    db.all(`SELECT hora, estado FROM horas`, (err, horas) => {
      ws.send(JSON.stringify({ tipo: 'estado_inicial', horas }));
    });
  });
}

function manejarMensaje(ws, mensaje) {
  let data;
  try {
    data = JSON.parse(mensaje);
  } catch {
    return ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Formato inválido' }));
  }

  const { tipo, hora, nombre } = data;

  if (tipo === 'pre-reservar') {
    const expiracion = Date.now() + 30000;
    limpiarExpiradasYBroadcast(() => {
      db.get(`SELECT estado FROM horas WHERE hora = ?`, [hora], (err, row) => {
        if (row?.estado === 'disponible') {
          db.run(`UPDATE horas SET estado='pre-reservado', expiracion=? WHERE hora=?`,
            [expiracion, hora], () => {
              broadcast('estado_actualizado', hora, 'pre-reservado');
            });
        } else {
          ws.send(JSON.stringify({ tipo: 'error', mensaje: 'No disponible para pre-reserva' }));
        }
      });
    });
  } else if (tipo === 'cancelar-pre-reserva') {
    db.run(`UPDATE horas SET estado='disponible', expiracion=NULL WHERE hora=? AND estado='pre-reservado'`,
      [hora], () => {
        broadcast('estado_actualizado', hora, 'disponible');
      });
  } else if (tipo === 'reservar') {
    if (!nombre) return ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Nombre requerido' }));
    db.get(`SELECT estado FROM horas WHERE hora=?`, [hora], (err, row) => {
      if (row?.estado === 'pre-reservado') {
        db.run(`UPDATE horas SET estado='reservado', nombre=?, expiracion=NULL WHERE hora=?`,
          [nombre, hora], () => {
            broadcast('estado_actualizado', hora, 'reservado', nombre);
          });
      } else {
        ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Hora no pre-reservada' }));
      }
    });
  } else {
    ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Tipo no reconocido' }));
  }
}

wss.on('connection', ws => {
  console.log('🧩 Cliente WebSocket conectado');
  enviarEstadoInicial(ws);
  ws.on('message', msg => manejarMensaje(ws, msg));
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor Express+WebSocket corriendo en http://localhost:${PORT}`);
});