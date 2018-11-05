package app

// A Room is a chatroom in which various Clients send messages to one another.
// Rooms are managed by a RoomService

import (
	"log"
	"runtime/debug"
	"time"

	"github.com/pkg/errors"
)

// RoomID identifies a *Room.
type RoomID string

// Room connects different Clients to one another. Messages incoming from
// Clients using Broadcast(incomingMessage) are sent to all other Clients in
// the Room at that time. Clients are registered in a Room using
// Register(Client) and are removed using Unregister(Client).
type Room struct {
	// Identifier of room
	id RoomID
	// Registered clients.
	clients map[*Client]bool
	// Inbound messages from clients.
	broadcast chan *incomingMessage
	// Register requests from clients.
	register chan *Client
	// Unregister requests from clients.
	unregister chan *Client
	// done chan closed when room exits
	done chan struct{}
	// panic chan only used for tests
	panic chan struct{}
}

func newRoom(id RoomID) *Room {
	return &Room{
		id:         id,
		broadcast:  make(chan *incomingMessage),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[*Client]bool),
		done:       make(chan struct{}),
		panic:      make(chan struct{}),
	}
}

// Run handles registering and unregistering Clients from the Room, and
// broadcasting messages from one Client to all others in the Room.
func (r *Room) Run() {
	defer func() {
		// recover if there was a panic and log error, stack trace
		if e := recover(); e != nil {
			log.Printf(
				"RoomPanic: Recovered panic in room.Run; closing room.\nRoomID: %s\nError: %s\nStack: %s",
				string(r.id),
				e,
				debug.Stack()
			)

			// close all Clients' connections
			for client := range r.clients {
				client.Close()
			}
		}

		// close done chan; this signals the RoomService to remove Room from its
		// storage.
		close(r.done)
	}()

	for {
		select {
		case client := <-r.register:
			register(r, client)

		case client := <-r.unregister:
			// if Room is empty after removing Client, unregister returns true;
			// otherwise, it returns false
			exit := unregister(r, client)
			if exit {
				return
			}

		case msg := <-r.broadcast:
			broadcast(r, msg)

		case <-r.panic:
			// this is only used in tests to make sure that Room recovers in case of
			// a panic
			panic(" °n° ")
		}
	}
}

func register(r *Room, client *Client) {
	// check to see if there is already a client with same ClientID in this
	// room
	for c := range r.clients {
		if c.id == client.id {
			// if so, close that client's channel and remove client
			delete(r.clients, c)
			c.Close()
		}
	}
	// add newly registered client
	r.clients[client] = true

	// broadcase message to other Clients that Client joined
	go func() {
		r.broadcast <- &incomingMessage{from: client, msgType: messageTypes.Joined, sendBackToFrom: true}
	}()
}

func unregister(r *Room, client *Client) (exit bool) {
	// if client is in room
	if _, ok := r.clients[client]; ok {
		// delete from room and close client's send channel.
		delete(r.clients, client)
		client.Close()

		// if room is empty, exit
		if len(r.clients) == 0 {
			exit = true
		}

		// broadcase message to other *Clients that client left
		go func() { r.broadcast <- &incomingMessage{from: client, msgType: messageTypes.Left} }()
	}
	return
}

func broadcast(r *Room, msg *incomingMessage) {
	// translate *incomingMessage to *outgoingMessage
	outgoingMsg := &outgoingMessage{
		Room:    r.id,
		From:    msg.from.id,
		MsgType: msg.msgType,
		Content: msg.content,
		SentAt:  time.Now(),
	}

	for client := range r.clients {
		if client.id != msg.from.id || msg.sendBackToFrom {
			successful := client.Send(outgoingMsg)
			// client's send channel buffer is full. something has probably gone
			// horribly wrong; remove client from room
			if !successful {
				delete(r.clients, client)
				client.Close()
			}
		}
	}
}

// Done returns a channel that sends an empty struct when a Room is closed.
// RoomService uses this to remove Room from itself.
func (r *Room) Done() <-chan struct{} {
	return r.done
}

// Register registers a Client as being in a Room.
func (r *Room) Register(client *Client) {
	r.register <- client
}

// Unregister removes a Client as being in a Room.
func (r *Room) Unregister(client *Client) {
	r.unregister <- client
}

// Broadcast sends an incomingMessage to all other Clients than the one
// who is broadcasting the message.
func (r *Room) Broadcast(msg *incomingMessage) {
	r.broadcast <- msg
}
