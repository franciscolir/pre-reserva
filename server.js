const express = require('express');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
// Inicialización
const app = express();
const PORT = 3099;


const db = new sqlite3.Database('./db.sqlite');

// Middleware
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





const server = app.listen(PORT, () => console.log(`Servidor iniciado en http://localhost:${PORT}`));

const wss = new WebSocket.Server({ server });
// DB: Inicialización de tabla y datos
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS horas (
      hora TEXT PRIMARY KEY,
      estado TEXT DEFAULT 'disponible',
      nombre TEXT,
      expiracion INTEGER
    )
  `);

  const horas = ['10:00', '10:30', '11:00', '11:30','12:00', '12:30', '13:00', '13:30',
    '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
    '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'
  ];
  horas.forEach(hora => {
    db.run(`INSERT OR IGNORE INTO horas (hora) VALUES (?)`, [hora]);
  });
});

// Función para emitir a todos los clientes
function broadcast(tipo, hora, estado, nombre = '') {
  const mensaje = JSON.stringify({ tipo, hora, estado, nombre });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(mensaje);
    }
  });
}

// Limpia pre-reservas expiradas y notifica
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
          filas.forEach(fila => {
            broadcast('estado_actualizado', fila.hora, 'disponible');
          });
        }
        callback?.();
      });
    }
  );
}

// Enviar estado inicial al cliente conectado
function enviarEstadoInicial(ws) {
  limpiarExpiradas(() => {
    db.all(`SELECT hora, estado FROM horas`, (err, horas) => {
      if (err) {
        console.error('Error obteniendo estado inicial:', err);
        ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Error al cargar horarios' }));
      } else {
        ws.send(JSON.stringify({ tipo: 'estado_inicial', horas }));
      }
    });
  });
}

// Manejo de mensajes WebSocket
function manejarMensaje(ws, mensaje) {
  let data;
  try {
    data = JSON.parse(mensaje);
  } catch {
    return ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Mensaje malformado' }));
  }

  const { tipo, hora, nombre } = data;

  switch (tipo) {
    case 'pre-reservar': {
      const expiracion = Date.now() + 30_000;
      limpiarExpiradas(() => {
        db.get(`SELECT estado FROM horas WHERE hora = ?`, [hora], (err, row) => {
          if (err) return enviarError(ws, 'Error interno');

          if (row && row.estado === 'disponible') {
            db.run(
              `UPDATE horas SET estado = 'pre-reservado', expiracion = ? WHERE hora = ?`,
              [expiracion, hora],
              err => {
                if (err) return enviarError(ws, 'No se pudo pre-reservar la hora');
                broadcast('estado_actualizado', hora, 'pre-reservado');
              }
            );
          } else {
            enviarError(ws, 'Hora no disponible para pre-reserva');
          }
        });
      });
      break;
    }

    case 'cancelar-pre-reserva': {
      db.run(
        `UPDATE horas SET estado = 'disponible', expiracion = NULL WHERE hora = ? AND estado = 'pre-reservado'`,
        [hora],
        err => {
          if (err) return enviarError(ws, 'Error cancelando pre-reserva');
          broadcast('estado_actualizado', hora, 'disponible');
        }
      );
      break;
    }

    case 'reservar': 
    
    
    {
      if (!nombre || !hora) return enviarError(ws, 'Faltan datos para reservar');

      db.get(`SELECT estado FROM horas WHERE hora = ?`, [hora], (err, row) => {
        if (err) return enviarError(ws, 'Error interno');

        if (row?.estado === 'pre-reservado') {
          db.run(
            `UPDATE horas SET estado = 'reservado', nombre = ?, expiracion = NULL WHERE hora = ?`,
            [nombre, hora],
            err => {
              if (err) return enviarError(ws, 'Error al reservar');
              broadcast('estado_actualizado', hora, 'reservado', nombre);
            }
          );
        } else {
          enviarError(ws, 'La hora no está pre-reservada o ya fue tomada');
        }
      });
      break;
    }

    default:
      enviarError(ws, 'Tipo de acción desconocido');
  }
}

// Enviar error a un solo cliente
function enviarError(ws, mensaje) {
  ws.send(JSON.stringify({ tipo: 'error', mensaje }));
}

// WebSocket: manejo de conexión
wss.on('connection', ws => {
  console.log('Cliente conectado');
  ws.on('message', message => manejarMensaje(ws, message));
  enviarEstadoInicial(ws);
});

// Limpieza automática periódica
setInterval(() => {
  limpiarExpiradas();
}, 5000);


