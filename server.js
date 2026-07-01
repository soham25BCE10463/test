const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const ARENA_WIDTH = 2500;
const ARENA_HEIGHT = 2500;

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Detect local network IP address (WiFi / LAN)
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Look for IPv4 addresses that are not internal (127.0.0.1)
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIpAddress();
const JOIN_URL = `http://${LOCAL_IP}:${PORT}`;
let qrCodeDataUrl = '';

// Generate QR code for the local WiFi URL
QRCode.toDataURL(JOIN_URL, { margin: 2, scale: 6 })
  .then(url => {
    qrCodeDataUrl = url;
  })
  .catch(err => {
    console.error('Error generating QR code:', err);
  });

// API endpoint to retrieve connection information
app.get('/api/info', (req, res) => {
  res.json({
    localIp: LOCAL_IP,
    port: PORT,
    joinUrl: JOIN_URL,
    qrCode: qrCodeDataUrl
  });
});

// Game state
const players = {};
const projectiles = {};
const powerups = [];
const particles = []; // Track explosion actions to broadcast to clients

const POWERUP_TYPES = {
  SHIELD: 'shield',      // Increases max health or shields damage
  SPEED: 'speed',        // Faster movement speed
  RAPID_FIRE: 'rapid'    // Decreases bullet cooldown
};

let projectileIdCounter = 0;
let powerupIdCounter = 0;

// Spawning rules
const MAX_POWERUPS = 12;
const POWERUP_SPAWN_INTERVAL = 6000; // Spawn every 6 seconds if under max

// Generate random position in arena
function getRandomPosition(radius = 20) {
  return {
    x: Math.random() * (ARENA_WIDTH - radius * 2) + radius,
    y: Math.random() * (ARENA_HEIGHT - radius * 2) + radius
  };
}

// Spawn a power-up
function spawnPowerup() {
  if (powerups.length >= MAX_POWERUPS) return;

  const pos = getRandomPosition(15);
  const types = Object.values(POWERUP_TYPES);
  const randomType = types[Math.floor(Math.random() * types.length)];

  const powerup = {
    id: powerupIdCounter++,
    x: pos.x,
    y: pos.y,
    type: randomType,
    radius: 15
  };

  powerups.push(powerup);
  io.emit('powerupsUpdate', powerups);
}

// Start power-up spawning loop
setInterval(spawnPowerup, POWERUP_SPAWN_INTERVAL);

// Handle new client connections
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Create initial player state (not joined until username provided)
  players[socket.id] = {
    id: socket.id,
    joined: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    name: 'Anonymous',
    color: '#00ffff',
    shipType: 'fighter',
    radius: 20,
    health: 100,
    maxHealth: 100,
    score: 0,
    lastShot: 0,
    speedBoostActive: false,
    speedBoostTimer: 0,
    rapidFireActive: false,
    rapidFireTimer: 0,
    shieldActive: false,
    shieldValue: 0
  };

  // Listen for join details
  socket.on('join', (data) => {
    const player = players[socket.id];
    if (!player) return;

    const startPos = getRandomPosition(player.radius);
    player.joined = true;
    player.name = (data.name && data.name.trim().substring(0, 15)) || 'Noob';
    player.color = data.color || '#00ffcc';
    player.shipType = data.shipType || 'fighter';
    player.x = startPos.x;
    player.y = startPos.y;
    player.vx = 0;
    player.vy = 0;
    player.health = 100;
    player.maxHealth = 100;
    player.shieldActive = false;
    player.shieldValue = 0;
    player.speedBoostActive = false;
    player.rapidFireActive = false;

    // Send current game settings and initial states
    socket.emit('gameInit', {
      arenaWidth: ARENA_WIDTH,
      arenaHeight: ARENA_HEIGHT,
      playerId: socket.id
    });

    // Broadcast power-ups to this new player
    socket.emit('powerupsUpdate', powerups);

    console.log(`Player joined the arena: ${player.name} (${socket.id})`);
    io.emit('playerJoined', { id: socket.id, name: player.name, color: player.color });
  });

  // Listen for user controls (movement inputs and shooting)
  socket.on('playerInput', (data) => {
    const player = players[socket.id];
    if (!player || !player.joined) return;

    // 1. Handle Movement Input Vector
    let targetSpeed = 6.0;
    if (player.speedBoostActive) {
      targetSpeed = 9.0;
    }

    if (data.moveVector) {
      // Joystick or normalized vector
      const mag = Math.sqrt(data.moveVector.x * data.moveVector.x + data.moveVector.y * data.moveVector.y);
      if (mag > 0) {
        const nx = data.moveVector.x / mag;
        const ny = data.moveVector.y / mag;
        // Apply acceleration towards input vector
        player.vx = nx * targetSpeed;
        player.vy = ny * targetSpeed;
      } else {
        player.vx = 0;
        player.vy = 0;
      }
    } else {
      // Fallback or keyboard inputs
      let dx = 0;
      let dy = 0;
      if (data.keys) {
        if (data.keys.w || data.keys.up) dy -= 1;
        if (data.keys.s || data.keys.down) dy += 1;
        if (data.keys.a || data.keys.left) dx -= 1;
        if (data.keys.d || data.keys.right) dx += 1;
      }
      
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag > 0) {
        player.vx = (dx / mag) * targetSpeed;
        player.vy = (dy / mag) * targetSpeed;
      } else {
        // Friction / deceleration
        player.vx *= 0.75;
        player.vy *= 0.75;
        if (Math.abs(player.vx) < 0.1) player.vx = 0;
        if (Math.abs(player.vy) < 0.1) player.vy = 0;
      }
    }

    // 2. Handle Rotation Angle
    if (typeof data.angle === 'number') {
      player.angle = data.angle;
    }

    // 3. Handle Shooting action
    if (data.shoot) {
      const now = Date.now();
      let cooldown = 350; // default 350ms shoot cooldown
      if (player.rapidFireActive) {
        cooldown = 120; // super fast shooting
      }

      if (now - player.lastShot >= cooldown) {
        player.lastShot = now;
        
        // Spawn bullet starting at edge of player radius
        const bulletSpeed = 12;
        const spawnDist = player.radius + 5;
        const bx = player.x + Math.cos(player.angle) * spawnDist;
        const by = player.y + Math.sin(player.angle) * spawnDist;
        const bvx = Math.cos(player.angle) * bulletSpeed;
        const bvy = Math.sin(player.angle) * bulletSpeed;

        const projId = projectileIdCounter++;
        projectiles[projId] = {
          id: projId,
          ownerId: socket.id,
          x: bx,
          y: by,
          vx: bvx,
          vy: bvy,
          radius: 5,
          color: player.color,
          damage: 15,
          range: 800, // Distance bullet travels before dying
          distTraveled: 0
        };
      }
    }
  });

  // Handle client disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    const name = players[socket.id]?.name;
    delete players[socket.id];
    io.emit('playerLeft', { id: socket.id, name });
  });
});

// Main server update loop (60 FPS)
function updateGame() {
  const joinedPlayers = Object.values(players).filter(p => p.joined);
  const now = Date.now();

  // 1. Update Player Power-up timers and position bounds
  joinedPlayers.forEach(player => {
    // Speed boost timer check
    if (player.speedBoostActive && now > player.speedBoostTimer) {
      player.speedBoostActive = false;
    }
    // Rapid fire timer check
    if (player.rapidFireActive && now > player.rapidFireTimer) {
      player.rapidFireActive = false;
    }

    // Apply movement velocities
    player.x += player.vx;
    player.y += player.vy;

    // Apply boundaries (bounce or block)
    if (player.x < player.radius) {
      player.x = player.radius;
      player.vx = 0;
    } else if (player.x > ARENA_WIDTH - player.radius) {
      player.x = ARENA_WIDTH - player.radius;
      player.vx = 0;
    }

    if (player.y < player.radius) {
      player.y = player.radius;
      player.vy = 0;
    } else if (player.y > ARENA_HEIGHT - player.radius) {
      player.y = ARENA_HEIGHT - player.radius;
      player.vy = 0;
    }

    // Check collision with Power-ups
    for (let i = powerups.length - 1; i >= 0; i--) {
      const pu = powerups[i];
      const dist = Math.hypot(player.x - pu.x, player.y - pu.y);
      if (dist < player.radius + pu.radius) {
        // Apply power-up effect
        if (pu.type === POWERUP_TYPES.SHIELD) {
          player.shieldActive = true;
          player.shieldValue = 50; // Gives 50 shield points (absorbs damage)
        } else if (pu.type === POWERUP_TYPES.SPEED) {
          player.speedBoostActive = true;
          player.speedBoostTimer = now + 8000; // 8 seconds of speed boost
        } else if (pu.type === POWERUP_TYPES.RAPID_FIRE) {
          player.rapidFireActive = true;
          player.rapidFireTimer = now + 6000; // 6 seconds of rapid fire
        }

        // Broadcast sound/notify action and update list
        io.emit('powerupCollected', { playerId: player.id, type: pu.type, id: pu.id });
        powerups.splice(i, 1);
        io.emit('powerupsUpdate', powerups);
      }
    }
  });

  // 2. Update Projectiles
  Object.keys(projectiles).forEach(id => {
    const proj = projectiles[id];
    
    // Move projectile
    proj.x += proj.vx;
    proj.y += proj.vy;
    
    // Accumulate distance
    const speed = Math.hypot(proj.vx, proj.vy);
    proj.distTraveled += speed;

    let destroyed = false;

    // Check out of bounds
    if (proj.x < 0 || proj.x > ARENA_WIDTH || proj.y < 0 || proj.y > ARENA_HEIGHT || proj.distTraveled >= proj.range) {
      destroyed = true;
    } else {
      // Check collision with players (excluding the projectile owner)
      for (const player of joinedPlayers) {
        if (player.id === proj.ownerId) continue;

        const dist = Math.hypot(proj.x - player.x, proj.y - player.y);
        if (dist < player.radius + proj.radius) {
          destroyed = true;
          
          // Apply damage
          let finalDamage = proj.damage;
          if (player.shieldActive) {
            player.shieldValue -= finalDamage;
            if (player.shieldValue <= 0) {
              player.shieldActive = false;
              player.shieldValue = 0;
            }
          } else {
            player.health -= finalDamage;
          }

          // Trigger hit particle effect on client
          io.emit('playerHit', { 
            playerId: player.id, 
            damage: finalDamage, 
            x: proj.x, 
            y: proj.y, 
            color: proj.color 
          });

          // Check if dead
          if (player.health <= 0) {
            player.health = 0;
            
            // Increment killer's score
            const killer = players[proj.ownerId];
            if (killer) {
              killer.score += 1;
            }

            // Emit death event (for explosion particles on client)
            io.emit('playerDeath', { 
              playerId: player.id, 
              name: player.name,
              color: player.color,
              x: player.x, 
              y: player.y,
              killerName: killer ? killer.name : 'Unknown'
            });

            // Respawn player
            const respawnPos = getRandomPosition(player.radius);
            player.x = respawnPos.x;
            player.y = respawnPos.y;
            player.vx = 0;
            player.vy = 0;
            player.health = 100;
            player.shieldActive = false;
            player.shieldValue = 0;
            player.speedBoostActive = false;
            player.rapidFireActive = false;
          }
          break;
        }
      }
    }

    if (destroyed) {
      delete projectiles[id];
    }
  });

  // 3. Compile and broadcast state
  const state = {
    players: {},
    projectiles: Object.values(projectiles)
  };

  joinedPlayers.forEach(p => {
    state.players[p.id] = {
      id: p.id,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      radius: p.radius,
      angle: p.angle,
      name: p.name,
      color: p.color,
      shipType: p.shipType,
      health: p.health,
      maxHealth: p.maxHealth,
      shieldActive: p.shieldActive,
      shieldValue: p.shieldValue,
      speedBoostActive: p.speedBoostActive,
      rapidFireActive: p.rapidFireActive,
      score: p.score
    };
  });

  io.emit('gameUpdate', state);
}

// Update game loop at ~60fps (16.67ms interval)
setInterval(updateGame, 1000 / 60);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`-----------------------------------------------`);
  console.log(`Server starting on port ${PORT}...`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`WiFi Join URL: ${JOIN_URL}`);
  console.log(`-----------------------------------------------`);
});
