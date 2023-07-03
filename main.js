/*
 *
 * Gennia server side
 * Copyright (c) 2022 Reqwey Lin (https://github.com/Reqwey)
 *
 */

// Modules to control application life and create native browser window
const path = require("path");
const { Server } = require("socket.io");
const crypto = require("crypto");
const xss = require("xss");
const GameMap = require("./src/server/map");
const Point = require("./src/server/point");
const Player = require("./src/server/player");
const { getIPAdress } = require("./util");
const express = require("express");
const app = express();
const genniaserver = require("./package.json");
const http = require("http");
const server = http.createServer(app);

const speedArr = [0.25, 0.5, 0.75, 1, 2, 3, 4];
const forceStartOK = [1, 2, 2, 3, 3, 4, 5, 5, 6];
//                    0  1  2  3  4  5  6  7  8

global.serverConfig = {
  name: process.argv[2] || "GenniaServer",
  port: process.argv[3] || 8080,
};

global.serverRunning = false;
global.lobbies = [];

const io = new Server(server);

app.use(express.static(__dirname + "/src/frontend/"));

server.listen(global.serverConfig.port, () => {
  global.serverRunning = true;
  console.log(
    `Server "${
      global.serverConfig.name
    }" established at http://${getIPAdress()}:${global.serverConfig.port}`
  );
});

async function handleDisconnectInGame(player, io, lobbyId) {
  try {
    io.to(`room${lobbyId}`).local.emit("room_message", player.trans(), "quit.");
    lobbies[lobbyId].players = lobbies[lobbyId].players.filter(
      (p) => p.id != player.id
    );
  } catch (e) {
    console.log(e.message);
  }
}

async function handleDisconnectInRoom(player, io, lobbyId) {
  try {
    io.to(`room${lobbyId}`).local.emit("room_message", player.trans(), "quit.");
    let newPlayers = [];
    lobbies[lobbyId].forceStartNum = 0;
    for (let i = 0, c = 0; i < lobbies[lobbyId].players.length; ++i) {
      if (lobbies[lobbyId].players[i].id !== player.id) {
        lobbies[lobbyId].players[i].color = c++;
        newPlayers.push(lobbies[lobbyId].players[i]);
        if (lobbies[lobbyId].players[i].forceStart) {
          ++lobbies[lobbyId].forceStartNum;
        }
      }
    }
    io.to(`room${lobbyId}`).local.emit(
      "force_start_changed",
      lobbies[lobbyId].forceStartNum
    );
    lobbies[lobbyId].players = newPlayers;
    if (lobbies[lobbyId].players.length > 0)
      lobbies[lobbyId].players[0].setRoomHost(true);
    io.to(`room${lobbyId}`).local.emit(
      "players_changed",
      lobbies[lobbyId].players.map((player) => player.trans())
    );
  } catch (e) {
    console.log(e.message);
  }
}

async function getPlayerIndex(playerId, lobbyId) {
  // console.log("Called getPlayerIndex");
  for (let i = 0; i < lobbies[lobbyId].players.length; ++i) {
    if (lobbies[lobbyId].players[i].id === playerId) {
      // console.log("OK getPlayerIndex");
      return i;
    }
  }
  return -1;
}

async function getPlayerIndexBySocket(socketId, lobbyId) {
  // console.log("Called getPlayerIndexBySocket");
  for (let i = 0; i < lobbies[lobbyId].players.length; ++i) {
    if (lobbies[lobbyId].players[i].socket_id === socketId) {
      // console.log("OK getPlayerIndexBySocket");
      return i;
    }
  }
  return -1;
}

async function handleGame(io, lobbyId) {
  try {
    if (lobbies[lobbyId].gameStarted === false) {
      console.info(`Start game ${lobbyId}`);
      let allsockets = await io.to(`room${lobbyId}`).fetchSockets();
      for (let socket of allsockets) {
        let playerIndex = await getPlayerIndexBySocket(socket.id, lobbyId);
        if (playerIndex !== -1) {
          socket.emit(
            "game_started",
            lobbies[lobbyId].players[playerIndex].color
          );
        }
      }
      lobbies[lobbyId].gameStarted = true;
      console.log(lobbyId, lobbies[lobbyId].gameStarted);

      lobbies[lobbyId].map = new GameMap(
        lobbies[lobbyId].gameConfig.mapWidth,
        lobbies[lobbyId].gameConfig.mapHeight,
        lobbies[lobbyId].gameConfig.mountain,
        lobbies[lobbyId].gameConfig.city,
        lobbies[lobbyId].gameConfig.swamp,
        lobbies[lobbyId].players
      );
      lobbies[lobbyId].players = await lobbies[lobbyId].map.generate();
      lobbies[lobbyId].mapGenerated = true;

      io.to(`room${lobbyId}`).local.emit(
        "init_game_map",
        lobbies[lobbyId].map.width,
        lobbies[lobbyId].map.height
      );

      for (let socket of allsockets) {
        let playerIndex = await getPlayerIndexBySocket(socket.id, lobbyId);
        let player = lobbies[lobbyId].players[playerIndex];

        socket.on("attack", async (from, to, isHalf) => {
          try {

            if (
              player.operatedTurn < lobbies[lobbyId].map.turn &&
              lobbies[lobbyId].map.commandable(player, from, to)
            ) {
              if (isHalf) {
                lobbies[lobbyId].map.moveHalfMovableUnit(player, from, to);
              } else {
                lobbies[lobbyId].map.moveAllMovableUnit(player, from, to);
              }
  
              lobbies[lobbyId].players[playerIndex].operatedTurn =
                lobbies[lobbyId].map.turn;
              socket.emit("attack_success", from, to);
            } else {
              socket.emit("attack_failure", from, to);
            }
          } catch (e) {
            console.log(e);
          }
        });
      }

      let updTime = 500 / speedArr[lobbies[lobbyId].gameConfig.gameSpeed];
      lobbies[lobbyId].gameLoop = setInterval(async () => {
        try {
          let allsockets = await io.to(`room${lobbyId}`).fetchSockets();
          lobbies[lobbyId].players.forEach(async (player) => {
            let block = lobbies[lobbyId].map.getBlock(player.king);

            let blockPlayerIndex = await getPlayerIndex(
              block.player.id,
              lobbyId
            );
            if (blockPlayerIndex !== -1) {
              if (block.player !== player && player.isDead === false) {
                console.log(block.player.username, "captured", player.username);
                io.to(`room${lobbyId}`).local.emit(
                  "captured",
                  block.player.trans(),
                  player.trans()
                );
                try {
                  io.sockets.sockets
                    .get(player.socket_id)
                    .emit("game_over", block.player.trans());
                } catch (_) {}
                player.isDead = true;
                lobbies[lobbyId].map.getBlock(player.king).kingBeDominated();
                player.land.forEach((block) => {
                  lobbies[lobbyId].map.transferBlock(
                    block,
                    lobbies[lobbyId].players[blockPlayerIndex]
                  );
                  lobbies[lobbyId].players[blockPlayerIndex].winLand(block);
                });
                player.land.length = 0;
              }
            }
          });
          let alivePlayer = null,
            countAlive = 0;
          for (let a of lobbies[lobbyId].players)
            if (!a.isDead) (alivePlayer = a), ++countAlive;
          if (countAlive === 1) {
            io.to(`room${lobbyId}`).local.emit("game_ended", alivePlayer.id);
            lobbies[lobbyId].gameStarted = false;
            lobbies[lobbyId].forceStartNum = 0;
            console.log("Game ended");
            clearInterval(lobbies[lobbyId].gameLoop);
          }

          let leaderBoard = lobbies[lobbyId].players
            .map((player) => {
              let data = lobbies[lobbyId].map.getTotal(player);
              return {
                color: player.color,
                username: player.username,
                army: data.army,
                land: data.land,
              };
            })
            .sort((a, b) => {
              return b.army - a.army || b.land - a.land;
            });

          for (let socket of allsockets) {
            let playerIndex = await getPlayerIndexBySocket(socket.id, lobbyId);
            if (playerIndex !== -1) {
              let view = await lobbies[lobbyId].map.getViewPlayer(
                lobbies[lobbyId].players[playerIndex]
              );
              view = view.map((row) =>
                row.map((item) => [item.type, item.color, item.unit])
              );
              view = JSON.stringify(view);
              socket.emit(
                "game_update",
                view,
                lobbies[lobbyId].map.width,
                lobbies[lobbyId].map.height,
                lobbies[lobbyId].turn,
                leaderBoard
              );
            }
          }
          lobbies[lobbyId].map.updateTurn();
          lobbies[lobbyId].map.updateUnit();
        } catch (e) {
          console.log(e);
        }
      }, updTime);
    }
  } catch (e) {
    console.log(e);
  }
}

// Listen for socket.io connections

// io.on('connect', async (socket) => {
//   console.log(io.sockets.sockets)
// })
io.on("connection", (socket) => {
  if (lobbies.length === 0 || lobbies[lobbies.length - 1].gameStarted) {
    lobbies.push({
      gameStarted: false,
      map: undefined,
      gameLoop: undefined,
      gameConfig: {
        maxPlayers: 8,
        gameSpeed: 3,
        mapWidth: 0.75,
        mapHeight: 0.75,
        mountain: 0.5,
        city: 0.5,
        swamp: 0,
      },
      players: [],
      generals: [],
      forceStartNum: 0,
    });
    console.log("Get a new game lobby", lobbies.length);
  }
  socket.join(`room${lobbies.length - 1}`);

  socket.on("query_server_info", async () => {
    socket.emit(
      "server_info",
      global.serverConfig.name,
      genniaserver.version,
      lobbies[lobbies.length - 1].gameStarted,
      lobbies[lobbies.length - 1].players.length,
      lobbies[lobbies.length - 1].forceStartNum,
      lobbies[lobbies.length - 1].gameConfig.maxPlayers
    );
  });

  let player;

  // socket.on("reconnect", async (playerId) => {
  //   try {
  //     if (lobbies[lobbies.length - 1].gameStarted) {
  //       // Allow to reconnect
  //       let playerIndex = await getPlayerIndex(playerId, lobbies.length - 1);
  //       if (playerIndex !== -1) {
  //         player = lobbies[lobbies.length - 1].players[playerIndex];
  //         lobbies[lobbies.length - 1].players[playerIndex].socket_id =
  //           socket.id;
  //         io.to(`room${lobbies.length - 1}`).local.emit(
  //           "room_message",
  //           player.trans(),
  //           "re-joined the lobby."
  //         );
  //       }
  //     }
  //   } catch (e) {
  //     socket.emit("error", "An unknown error occurred: " + e.message, e.stack);
  //   }
  // });

  socket.on("set_username", async (username) => {
    try {
      username = xss(username);
      if (username.length === 0 || username.length > 15) {
        username = "Anonymous";
      }
      // This socket will be first called when the player connects the server
      let playerId = crypto
        .randomBytes(Math.ceil(10 / 2))
        .toString("hex")
        .slice(0, 10);
      console.log(
        "Player:",
        username,
        "playerId:",
        playerId,
        "lobby:",
        lobbies.length - 1
      );
      socket.emit("set_player_id", playerId);

      player = new Player(
        playerId,
        lobbies.length - 1,
        socket.id,
        username,
        lobbies[lobbies.length - 1].players.length
      );

      lobbies[lobbies.length - 1].players.push(player);
      let playerIndex = lobbies[lobbies.length - 1].players.length - 1;

      io.to(`room${lobbies.length - 1}`).local.emit(
        "room_message",
        player.trans(),
        "joined the lobby."
      );
      io.to(`room${lobbies.length - 1}`).local.emit(
        "players_changed",
        lobbies[lobbies.length - 1].players.map((player) => player.trans())
      );

      if (lobbies[lobbies.length - 1].players.length === 1) {
        console.log(lobbies[lobbies.length - 1].players[playerIndex]);
        lobbies[lobbies.length - 1].players[playerIndex].setRoomHost(true);
      }
      lobbies[lobbies.length - 1].players[playerIndex].username = username;
      io.to(`room${lobbies.length - 1}`).local.emit(
        "players_changed",
        lobbies[lobbies.length - 1].players.map((player) => player.trans())
      );

      // Only emit to this player so it will get the latest status
      socket.emit(
        "force_start_changed",
        lobbies[lobbies.length - 1].forceStartNum
      );

      if (
        lobbies[lobbies.length - 1].players.length >=
        lobbies[lobbies.length - 1].gameConfig.maxPlayers
      ) {
        await handleGame(io, lobbies.length - 1);
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("get_game_settings", async () => {
    socket.emit("push_game_settings", lobbies[lobbies.length - 1].gameConfig);
  });

  socket.on("change_host", async (userId) => {
    try {
      if (player.isRoomHost) {
        let currentHost = await getPlayerIndex(
          player.id,
          lobbies.length - 1,
          lobbies.length - 1
        );
        let newHost = await getPlayerIndex(userId, lobbies.length - 1);
        if (newHost !== -1) {
          lobbies[lobbies.length - 1].players[currentHost].setRoomHost(false);
          lobbies[lobbies.length - 1].players[newHost].setRoomHost(true);
          io.to(`room${lobbies.length - 1}`).local.emit(
            "players_changed",
            lobbies[lobbies.length - 1].players.map((player) => player.trans())
          );
        }
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_game_speed", async (value) => {
    try {
      if (player.isRoomHost) {
        console.log("Changing game speed to " + speedArr[value] + "x");
        lobbies[lobbies.length - 1].gameConfig.gameSpeed = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the game speed to ${speedArr[value]}x.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_map_width", async (value) => {
    try {
      if (player.isRoomHost) {
        console.log("Changing map width to" + value);
        lobbies[lobbies.length - 1].gameConfig.mapWidth = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the map width to ${value}.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_map_height", async (value) => {
    try {
      if (player.isRoomHost) {
        console.log("Changing map height to" + value);
        lobbies[lobbies.length - 1].gameConfig.mapHeight = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the map height to ${value}.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_mountain", async (value) => {
    try {
      if (player.isRoomHost) {
        console.log("Changing mountain to" + value);
        lobbies[lobbies.length - 1].gameConfig.mountain = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the mountain to ${value}.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_city", async (value) => {
    try {
      if (player.isRoomHost) {
        console.log("Changing city to" + value);
        lobbies[lobbies.length - 1].gameConfig.city = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the city to ${value}.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_swamp", async (value) => {
    try {
      if (player.isRoomHost) {
        console.log("Changing swamp to" + value);
        lobbies[lobbies.length - 1].gameConfig.swamp = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the swamp to ${value}.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("change_max_player_num", async (value) => {
    try {
      if (player.isRoomHost) {
        if (value <= 1) {
          socket.emit(
            "error",
            "Changement was failed",
            "Max player num is invalid."
          );
          return;
        }
        console.log("Changing max players to" + value);
        lobbies[lobbies.length - 1].gameConfig.maxPlayers = value;
        io.to(`room${lobbies.length - 1}`).local.emit(
          "game_config_changed",
          lobbies[lobbies.length - 1].gameConfig
        );
        io.to(`room${lobbies.length - 1}`).local.emit(
          "room_message",
          player.trans(),
          `changed the max player num to ${value}.`
        );
      } else {
        socket.emit(
          "error",
          "Changement was failed",
          "You are not the game host."
        );
      }
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("player_message", async (message) => {
    io.to(`room${lobbies.length - 1}`).local.emit(
      "room_message",
      player.trans(),
      ": " + message
    );
  });

  socket.on("disconnect", async () => {
    if (!lobbies[lobbies.length - 1].gameStarted)
      await handleDisconnectInRoom(player, io, lobbies.length - 1);
    else await handleDisconnectInGame(player, io, lobbies.length - 1);
  });

  socket.on("leave_game", async () => {
    try {
      socket.disconnect();
      await handleDisconnectInGame(player, io, lobbies.length - 1);
    } catch (e) {
      console.log(e.message);
    }
  });

  socket.on("force_start", async () => {
    try {
      let playerIndex = await getPlayerIndex(player.id, lobbies.length - 1);
      if (
        lobbies[lobbies.length - 1].players[playerIndex].forceStart === true
      ) {
        lobbies[lobbies.length - 1].players[playerIndex].forceStart = false;
        --lobbies[lobbies.length - 1].forceStartNum;
      } else {
        lobbies[lobbies.length - 1].players[playerIndex].forceStart = true;
        ++lobbies[lobbies.length - 1].forceStartNum;
      }
      io.to(`room${lobbies.length - 1}`).local.emit(
        "players_changed",
        lobbies[lobbies.length - 1].players.map((player) => player.trans())
      );
      io.to(`room${lobbies.length - 1}`).local.emit(
        "force_start_changed",
        lobbies[lobbies.length - 1].forceStartNum
      );

      if (
        lobbies[lobbies.length - 1].forceStartNum >=
        forceStartOK[lobbies[lobbies.length - 1].players.length]
      ) {
        await handleGame(io, lobbies.length - 1);
      }
    } catch (e) {
      console.log(e.message);
    }
  });
});
