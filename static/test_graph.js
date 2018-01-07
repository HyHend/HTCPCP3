graphCallback(
	6,
	{
		"graph": {
		  "nodes": [
			  	{"id": "0", "name": "a", "type": 1},
			  	{"id": "1", "name": "b", "type": 2},
			  	{"id": "2", "name": "c", "type": 3},
			  	{"id": "3", "name": "d", "type": 4}
		  	],
		  "edges": [
			  	{"src": "0", "dst": "1", "val": 1.0},
			  	{"src": "1", "dst": "2", "val": 1.0},
			  	{"src": "2", "dst": "3", "val": 1.0},
			  	{"src": "3", "dst": "0", "val": 1.0},
			  	{"src": "0", "dst": "2", "val": 1.0},
			  	{"src": "3", "dst": "1", "val": 1.0}
		  	]
		}
	});