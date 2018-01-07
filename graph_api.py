from flask import Flask
from flask import request
import json
import subprocess
import sys
import string
import random
import sqlite3
import time
import datetime
import socket
from StringIO import StringIO

app = Flask(__name__, static_url_path='')
app.config['DEBUG'] = False
DB_FOLDER = "/home/hylke/nf_graph_data"
DB_NAME = "nf_graph"

def init_sqlite_db(db):
  """ Reads database to tempfile
  """
  con = sqlite3.connect(db)
  tempfile = StringIO()
  for line in con.iterdump():
      tempfile.write('%s\n' % line)
  con.close()
  tempfile.seek(0)

  # Create a database in memory and import from tempfile
  app.sqlite = sqlite3.connect(":memory:")
  app.sqlite.cursor().executescript(tempfile.read())
  app.sqlite.commit()
  app.sqlite.row_factory = sqlite3.Row

  # TODO close app.sqlite on flask exit(!)
init_sqlite_db("{0}/{1}.db".format(DB_FOLDER, DB_NAME))

# @app.route('/')
# def base_level():
#     return 'No parameters given'

@app.route('/api/v1.0/graph', methods=['GET'])
def simple_api():
    req_dict = {
      "date": request.args.get('date'),
      "time_start": request.args.get('time_start'),
      "time_end": request.args.get('time_end'),
      "connections_start": request.args.get('connections_start'),
      "connections_end": request.args.get('connections_end'),
      "pkts_start": request.args.get('pkts_start'),
      "pkts_end": request.args.get('pkts_end'),
      "bytes_start": request.args.get('bytes_start'),
      "bytes_end": request.args.get('bytes_end'),
      "src_ports": request.args.get('src_ports'),
      "dst_ports": request.args.get('dst_ports'),
      "required_ips": request.args.get('required_ips'),
      "protocols": request.args.get('protocols'),
      "graph_type": request.args.get('type')
    }

    # Print request
    print req_dict

    test = request.args.get('test')
    if test and test == True:
      result = retrieve_mock_data()
    else:
      result = retrieve_data(req_dict)

    return result

@app.route('/api/v1.0/node', methods=['GET'])
def simple_node_api():
    node = request.args.get('node')
    result = retrieve_node_data(node)
    return result

def retrieve_node_data(node):
  """ Returns informational data on given node
  """

  # Connect with DB, create, execute query
  # con = sqlite3.connect("/home/hylke/3DVIS/data/nf_250_2.db") #:memory:
  # cur = con.cursor()
  cur = app.sqlite.cursor()

  # SRC
  cur.execute("""
      SELECT 
        SUM(pkts) AS pkts,
        SUM(bytes) AS bytes,
        SUM(rows) AS rows
      FROM t_{0}
      WHERE ds = "{1}"
      GROUP BY ds
      LIMIT 1;
    """.format(DB_NAME, ipInt))
  rows = cur.fetchall()

  # parse row
  src_pkts = ""
  src_bytes = ""
  src_rows = ""
  for row in rows:
    src_pkts = row[0]
    src_bytes = row[1]
    src_rows = row[2]

  # DST
  cur.execute("""
      SELECT 
        SUM(pkts) AS pkts,
        SUM(bytes) AS bytes,
        SUM(rows) AS rows
      FROM t_{0}
      WHERE da = "{1}"
      GROUP BY da
      LIMIT 1;
    """.format(DB_NAME, ipInt))
  rows = cur.fetchall()

  # parse row
  dst_pkts = ""
  dst_bytes = ""
  dst_rows = ""
  for row in rows:
    dst_pkts = row[0]
    dst_bytes = row[1]
    dst_rows = row[2]

  # Return JSON string
  return """nodeDataCallback(true, {{
      "node":"{0}",
      "sent_bytes":"{1}",
      "rcvd_bytes":"{2}",
      "sent_pkts":"{3}",
      "rcvd_pkts":"{4}",
      "rows":"{5}"
    }});
    """.format(node, 
        src_pkts, 
        dst_pkts, 
        src_bytes, 
        dst_bytes, 
        (src_rows + dst_rows))

def retrieve_data(request):
  """" Returns data from "database" filtered as required 
  by get request
  """
  # Retrieve values from JSON
  date = request['date'].split('-')
  hs = request['time_start'] if 'time_start' in request else 0      # This is lazy, you should just not put these fields in the query if they're not set...
  he = request['time_end'] if 'time_end' in request else 24
  src_ports = request['src_ports'] if 'src_ports' in request else ""
  dst_ports = request['dst_ports'] if 'dst_ports' in request else ""
  protocols = request['protocols'] if 'protocols' in request else ""
  pkts_start = int(request['pkts_start']) if 'pkts_start' in request else 0
  pkts_end = int(request['pkts_end']) if 'pkts_end' in request else 2147483646
  bytes_start = int(request['bytes_start']) if 'bytes_start' in request else 0
  bytes_end = int(request['bytes_end']) if 'bytes_end' in request else 2147483646
  connections_start = int(request['connections_start']) if 'connections_start' in request else 0
  connections_end = int(request['connections_end']) if 'connections_end' in request else 2147483646
  required_ips = request['required_ips'] if 'required_ips' in request else ""

  # Max of sliders should be "infinite" (taking max int)
  connections_end = 2147483646 if connections_end >= 100000 else connections_end
  pkts_end = 2147483646 if pkts_end >= 100000 else pkts_end
  bytes_end = 2147483646 if bytes_end >= 10000 else bytes_end

  # Format timeframe for query
  if int(hs) <= 23:
    hst = time.mktime(datetime.datetime.strptime('{0}.{1}'.format('-'.join(date), hs), "%d-%m-%Y.%H").timetuple())
  else:
    hst = time.mktime(datetime.datetime.strptime('{0}.23:59:59'.format('-'.join(date)), "%d-%m-%Y.%H:%M:%S").timetuple())
  if int(he) <= 23:
    het = time.mktime(datetime.datetime.strptime('{0}.{1}'.format('-'.join(date), he), "%d-%m-%Y.%H").timetuple())
  else:
    het = time.mktime(datetime.datetime.strptime('{0}.23:59:59'.format('-'.join(date)), "%d-%m-%Y.%H:%M:%S").timetuple())

  # Create src, dst port query part (and this is why it's better to not list many ports)
  src_port_query = []
  if len(src_ports) >= 1:
    src_ports = src_ports.split(',')
    for port in src_ports:
      src_port_query.append("(',' || sps || ',' LIKE '%,{0},%' )".format(port.strip()))#CONCAT(sps,',')
  if len(src_port_query) > 0:
    src_port_query = 'AND (('+' OR '.join(src_port_query) + ')'
  else:
    src_port_query = ""

  dst_port_query = []
  if len(dst_ports) >= 1:
    dst_ports = dst_ports.split(',')
    for port in dst_ports:
      dst_port_query.append("(',' || dps || ',' LIKE '%,{0},%' )".format(port.strip()))#CONCAT(dps,',')
  if len(dst_port_query) > 0 and len(src_port_query) > 0:
    dst_port_query = 'OR ('+' OR '.join(dst_port_query) + '))'
  elif len(dst_port_query) > 0 and len(src_port_query) <= 0:
    dst_port_query = 'AND ('+' OR '.join(dst_port_query) + ')'
  elif len(src_port_query) > 0:
    dst_port_query = ")"
  else:
    dst_port_query = ""

  # Create protocols query part
  protocols_query = []
  if len(protocols) >= 1:
    protocols = protocols.split(',')
    for protocol in protocols:
      protocols_query.append("(',' || prs || ',' LIKE '%,{0},%' )".format(protocol.strip()))#CONCAT(sps,',')
  if len(protocols_query) > 0:
    protocols_query = 'AND ('+' OR '.join(protocols_query) + ')'
  else:
    protocols_query = ""

  # Create IP query from input field
  ip_query = []
  if len(required_ips) >= 2:
    required_ips = required_ips.split(',')
    for ip in required_ips:
      if "/" not in ip:
        # single ip
        ip_query.append("(CAST(da AS INT) = {0} OR CAST(ds AS INT) = {0}) ".format(ip2int(ip.strip())))
      else:
        # ip range
        req_split = ip.strip().split('/')
        ip_part = req_split[0]
        bits = req_split[1]
        range_start = signip(int("{0:032b}".format(int(unsignip(ip2int(ip_part))))[:int(bits)].ljust(32,'0'),2))
        range_end = signip(int("{0:032b}".format(int(unsignip(ip2int(ip_part))))[:int(bits)].ljust(32,'1'),2))
        ip_query.append("((CAST(da AS INT) BETWEEN {0} AND {1}) OR (CAST(ds AS INT) BETWEEN {0} AND {1})) ".format(int(range_start),int(range_end)))
  if len(ip_query) > 0:
    ip_query = 'AND ('+' OR '.join(ip_query) + ')'
  else:
    ip_query = ""

  # Connect with DB, create, execute query
  # con = sqlite3.connect("/home/hylke/3DVIS/data/nf_250_v2.db")  #:memory:
  # cur = con.cursor()
  cur = app.sqlite.cursor()
  query = """
      SELECT 
        ds,
        da,
        pkts,
        bytes,
        rows
        FROM (SELECT 
          ds,
          da,
          SUM(pkts) AS pkts,
          SUM(bytes) AS bytes,
          SUM(rows) AS rows
        FROM t_{12}
        WHERE CAST(td AS INT) BETWEEN {0} AND {1}
        {8}
        {9}
        {10}
        {11}
        GROUP BY ds, da) AS a
      WHERE rows BETWEEN {2} AND {3}
      AND bytes BETWEEN {4} AND {5}
      AND pkts BETWEEN {6} AND {7};
    """.format(
      int(hst), 
      int(het), 
      int(connections_start), 
      int(connections_end), 
      int(bytes_start*1024*1024), 
      int(bytes_end*1024*1024), 
      int(pkts_start), 
      int(pkts_end),
      src_port_query,
      dst_port_query,
      protocols_query,
      ip_query,
      DB_NAME)

  # print query
  print("")
  print("==========")
  print(query)
  print("==========")
  print("")

  # Execute query
  cur.execute(query)          
  rows = cur.fetchall()

  # List of nodes, edges
  containsNodes = [];
  nodes = [];
  edges = [];

  # parse rows
  print("Parsing query results...")
  for row in rows:
    sa = row[0]
    da = row[1]
    pkts = row[2]
    nbytes = row[3]
    nrows = row[4]

    #Header: 1 td, 2 rows, 3 ds, 4 da, 5 sps, 6 dps, 7 pkts, 8 bytes (td = ts, ds = sa, da = da. Typo in CSV header...)
    edges.append('{{"src":"{0}", "dst":"{1}", "val":"{2}"}}'.format(sa, da, nrows))

    # Add src, dst nodes if not yet done
    if sa not in containsNodes:
      containsNodes.append(sa)
      nodes.append('{{"id":"{0}", "name":"{1}", "type":"1"}}'.format(sa, int2ip(unsignip(int(sa)))))
    if da not in containsNodes:
      containsNodes.append(da)
      nodes.append('{{"id":"{0}", "name":"{1}", "type":"1"}}'.format(da, int2ip(unsignip(int(da)))))

  # Get counts
  #nodeCount = len(nodes)
  edgeCount = len(edges)

  return 'graphCallback({0}, {{ "graph": {{ "nodes": [{1}], "edges": [{2}] }} }});'.format(edgeCount, ','.join(nodes), ','.join(edges))

def retrieve_mock_data():
  """ Returns mock data. To be used for API testing 
  without actual filtering, retrieval
  """
  return """
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
    """

def unsignip(ip):
    """Function to convert an IP (int) from signed to unsigned. The IP is converted only when negative.

    Args:
        ip (int): IP to convert.

    Returns:
        long: unsigned IP.
    """
    if ip < 0:
        return ip + 2**32
    else:
        return ip

def signip(ip):
    if ip >= 2**32:
        return ip - 2**32
    else:
        return ip

def int2ip(ip):
    """Transform an integer IP into its dotted representation.
    
    Args:
        ip (int) a numeric value not larger than 2**32 - 1
        and not smaller than -(2**31).
    Return:
        string: the ip in the dotted notation
    Raise:
        ValueError if the value is not a valid IPv4 address
    """
    try:
        if ip >= 1 << 32 or ip < -(1 << 31):
            raise ValueError("{0} is not a valid IPv4 address".format(repr(ip)))
        n = ip + (0b1 << 32) if ip < 0 else ip
        return ".".join(map(lambda i: str((n >> i) & 0xFF), [24, 16, 8, 0]))
    except:
        raise ValueError(
            "Cannot transform {0} to a dotted IPv4 address".format(repr(ip))
        )

def ip2int(dotted):
    """Transform a dotted IP into its (signed) int32 representation.
    TODO: this return a negative number in some cases. To check
    Args:
        dotted (string): a valid dotted IP address
    Returns:
        int: the ip as a signed 32 bit integer
    Raise:
        ValueError if the value is not a valid IPv4 address
    """
    try:
        ip_parts = [int(p) for p in dotted.split(".")]
        if len(ip_parts) != 4:
            raise ValueError(
               "{0} is not a valid IPv4 address".format(repr(dotted))
           )
        n = sum([ip_parts[s] << (len(ip_parts) - s - 1) * 8
                for s in range(0, len(ip_parts))])
        return n - (0b1 << 32) if n >= (0b1 << 31) else n
    except:
        raise ValueError(
           "Cannot transform {0} to an uint32 IPv4 address".format(repr(dotted))
        )