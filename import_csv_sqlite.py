import sys, csv, sqlite3

csv.field_size_limit(sys.maxsize)

# Read command line arguments
INPUT_FILE = ""
try:
	INPUT_FILE = sys.argv[1]
	if(len(sys.argv) > 2):
		DB_FOLDER = sys.argv[2]
		DB_NAME = sys.argv[3]
	else:
		DB_FOLDER = "/home/hylke/nf_graph_data"
		DB_NAME = "nf_graph"
except:
	print("Error: Incorrect command line arguments. Expected: INPUT_FILE DB_FOLDER(opt) DB_NAME(opt)")
	exit(1)

# Set up DB connection
con = sqlite3.connect("{0}/{1}.db".format(DB_FOLDER, DB_NAME))	#:memory:
cur = con.cursor()

# Create table
try:
	cur.execute("CREATE TABLE t_{0} (td, rows, ds, da, sps, dps, prs, pkts, bytes);".format(DB_NAME)) # use your column names here
except:
	pass

# Load file content into DB
with open('{0}'.format(INPUT_FILE),'rb') as fin: # `with` statement available in 2.5+
    # csv.DictReader uses first line in file for column headings by default
    dr = csv.DictReader(fin, delimiter='|')
    to_db = [(
	    	i['td'], 
	    	i['rows'], 
	    	i['ds'], 
	    	i['da'], 
	    	i['sps'], 
	    	i['dps'], 
	    	i['prs'], 
	    	i['pkts'], 
	    	i['bytes']
    	) for i in dr]

cur.executemany("INSERT INTO t_{0} (td, rows, ds, da, sps, dps, prs, pkts, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);".format(DB_NAME), to_db)
con.commit()
con.close()

#Header:
# td, rows, ds, da, sps, dps, pkts, bytes
# td|rows|ds|da|sps|dps|pkts|bytes