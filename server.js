require('dotenv').config(); // Cargar variables desde .env
const express = require('express');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const { createProxyServer } = require('http-proxy');

const app = express();
const PORT = 3000;

// Base de datos
const db = new sqlite3.Database('./db.sqlite');

// Middleware para archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint para obtener horas reservadas
app.get('/horas-reservadas', (req, res) => {
  db.all(`SELECT hora, nombre FROM horas WHERE estado = 'reservado'`, (err, filas) => {
    if (err) {
      console.error('Error obteniendo horas reservadas:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
    res.json(filas);
  });
});

// Ya no exponemos config.js para ocultar la IP

// Crear servidor HTTP para Express y WebSocket proxy
const server = http.createServer(app);

// Proxy WebSocket para redirigir /ws al WS real definido en .env
const wsProxy = createProxyServer({
  target: {
    host: process.env.WS_HOST,
    port: process.env.WS_PORT
  },
  ws: true,
  changeOrigin: true,
});

// Proxy WS: upgrade de conexión para /ws
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wsProxy.ws(req, socket, head);
  }
});

// Inicializar tabla y datos en la DB
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS horas (
      hora TEXT PRIMARY KEY,
      estado TEXT DEFAULT 'disponible',
      nombre TEXT,
      expiracion INTEGER
    )
  `);

  const horas = [
    '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
    '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
    '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'
  ];

  horas.forEach(hora => {
    db.run(`INSERT OR IGNORE INTO horas (hora) VALUES (?)`, [hora]);
  });
});

// Aquí no se crea WebSocket.Server local, porque el WebSocket real está en WS_HOST:WS_PORT

// Funciones de manejo de la DB y lógica permanecen para la API REST u otro uso

// Limpia pre-reservas expiradas y notifica (se puede mantener para API REST)
function limpiarExpiradas(callback) {
  const ahora = Date.now();
  db.run(
    `UPDATE horas 
     SET estado = 'disponible', expiracion = NULL 
     WHERE estado = 'pre-reservado' AND expiracion < ?`,
    [ahora],
    err => {
      if (err) {
        console.error('Error limpiando expiradas:', err);
        return callback?.();
      }

      db.all(`SELECT hora FROM horas WHERE estado = 'disponible' AND expiracion IS NULL`, (err, filas) => {
        if (err) {
          console.error('Error al consultar horas disponibles:', err);
        } else {
          // Aquí se podría emitir evento a WebSocket real o registrar logs
        }
        callback?.();
      });
    }
  );
}

// Ejecuta limpieza periódica para mantener DB actualizada
setInterval(() => {
  limpiarExpiradas();
}, 5000);

// Iniciar servidor HTTP con proxy WS
server.listen(PORT, () => {
  console.log(`Servidor Express + Proxy WS corriendo en http://localhost:${PORT}`);
  console.log(`Proxy WS redirige ws://localhost:${PORT}/ws → ws://${process.env.WS_HOST}:${process.env.WS_PORT}`);
});
