var ForceDirectedGraph;
(function () {

  ForceDirectedGraph = function (renderer, scene, vertextShaderText, fragmentShaderText, posFS , textCreator, typed=true) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = new THREE.Camera();
    this.camera.position.z = 1;
    this.vertextShaderText = vertextShaderText;
    this.fragmentShaderText = fragmentShaderText;
    this.posFS = posFS;
    this.inited = false;

    // For Text
    this.textNodes = [];
    this.textCreator = textCreator;
    this.defaultOpacity = 0.5;

    // Is the user in selection mode?
    this.selecting = false;

    // If typed is true, the "type" value from the graph declaration will be used
    // Each type will be assigned a color (hint: don't have too many types)
    // Each node is of a given type, will have this types color as his end of the edge
    this.typed = typed;
  }

  var Proto = ForceDirectedGraph.prototype;

  /**
   * Resets graph, all data structures
   */
  Proto.reset = function () {
    this.scene.remove(this.lines);
    this.scene.remove(this.particles);
    for (var i = 0; i < this.textNodes.length; i++) {
      this.scene.remove(this.textNodes[i]);
    }
    this.selecting = false;
    this.inited = false;
  }

  /**
   * Initiates graph. Reads, creates etc.
   */
  Proto.init = function (nodes, edges) {
    this.nodes = nodes;
    this.nodeCount = nodes.length || nodes;
    this.edges = edges;
    this.edgeCount = edges.length || edges;
    this.copyScene = null;
    this.copyMaterial = null;
    this.setupCopyShader();

    var dims = getTextureSize(this.nodeCount);

    this.setDimensions(dims[0], dims[1]);

    this.rt0 = getRenderTarget(dims[0], dims[1]);
    this.rt1 = this.rt0.clone();
    this.rt2 = this.rt0.clone();
    this.rt3 = getRenderTarget(1, 1);

    // Picking* is an off display rendered version 
    //   of the graph containing for each node an unique color
    // When we click on screen, we check what the color of 
    //   the pixel is on the off display pickingScene
    // Now the color of the pixel indicates te node we clicked on 
    //  (can be translated back)
    this.pickingScene = new THREE.Scene();
    this.pickingTexture = new THREE.WebGLRenderTarget(WIDTH, HEIGHT);
    this.pickingTexture.generateMipmaps = false;
    
    this.copyTexture(getRandomTexture(dims[0], dims[1], this.nodeCount), this.rt0);
    this.copyTexture(this.rt0, this.rt1);
    this.rtIdx = true;
    this.setupForcesShader(this.vertextShaderText, this.fragmentShaderText);
    this.setupPositionShader(this.posFS);

    // Add edges to structure to be shown on screen
    if (this.edges.length) {
      this.populateEdgeGeometry();
    }
    else {
      console.log("No edges were found.")
    }

    this.setupLines();
    this.setupParticles();
    this.setupText();
    this.setupPicker();
    this.inited = true;
  }

  /**
   * Returns color based on the value in the range given
   * 0, 0, 255 will return color at 0. 10, 10, 255 will do the same
   */
  Proto.colorMap = function(value, range_min = 0, range_max = 7) {
    // http://google.github.io/palette.js/
    var range = Math.abs(range_max - range_min)
    var idx = value - range_min - 1;
    var pal = palette('tol-rainbow', range);  //cb-YlOrRd //sol-accent //tol-rainbow //tol-dv
    color = pal[idx];

    return new THREE.Color("#"+color);
  }

  /**
   * Parse graph from JSON (nodes, edges)
   */
  Proto.loadJSON = function (json) {
    var NID = 0;
    var nodes = {};
    var nodeTypes = {};
    var nodeArr = [];
    var edges = [];

    var jsg = json.graph;
    var jsgn = jsg.nodes;
    var jsge = jsg.edges;

    // Remember which node types were seen
    var distinctNodeTypes = [];

    // Nodes
    for(i in jsgn) {
      node = jsgn[i];
      nodes[node.id] = NID++;
      nodeArr.push(node.name);

      // Get node type (backwards compatible)
      if(node.type == undefined) { node.type = 1; }
      nodeTypes[node.id] = node.type;

      // Add to distinctNodeTypes if not yet added
      if(distinctNodeTypes.indexOf(node.type) == -1) {
        distinctNodeTypes.push(node.type);
      }
    }

    // Edges
    for(i in jsge) {
      edge = jsge[i];
      var src = nodes[edge.src];
      var dst = nodes[edge.dst];
      var val = edge.val;

      // Calculate colors. Only for non-directed graph
      if(!typed) {
        srcColor = 0;   // These are not in use in directed mode. Therefore not calculated
        dstColor = 0;
      }
      else {
        // Set color of edge based on node types of either side
        var srcColor = this.colorMap(nodeTypes[edge.src], 0, distinctNodeTypes.length);
        var dstColor = this.colorMap(nodeTypes[edge.dst], 0, distinctNodeTypes.length);
      }

      // Only add the edge if both nodes exist
      // For this edge, set src, dst, val (weight) and colors of both sides
      if (src != undefined && dst != undefined) {
        edges.push({
          src: src,
          dst: dst,
          val: val,
          srcColor: srcColor,
          dstColor: dstColor});
      }
      else {
        console.log("Edge was not added due to nonexisting node. (from, to, value),", src, dst, val);
      }
    }

    this.init(nodeArr, edges);
  }

  /**
   * Set force material
   * Handles combination between vertices pushing eachother away 
   * and edges pulling eachother together
   */
  Proto.computeForces = function () {
    var input;
    if (this.rtIdx) {
      input = this.rt0;
    } else {
      input = this.rt1;
    }

    this.forceMaterial.uniforms.texture1.value = input;

    this.forceMaterial.uniforms.firstVertex.value = 1;
    this.renderer.render(this.forceScene, this.camera, this.rt2, false);

    this.renderer.autoClear = false;
    this.forceMaterial.uniforms.firstVertex.value = 0;
    this.renderer.render(this.forceScene, this.camera, this.rt2, false);
    this.renderer.autoClear = true;
  }

  /**
   * Based on calculations resulting from force material, 
   * change the positions of the particles, lines, textures to comply
   */
  Proto.updatePositions = function () {
    var input, output;
    if (this.rtIdx) {
      input = this.rt0;
      output = this.rt1;
    } else {
      input = this.rt1;
      output = this.rt0;
    }
    this.rtIdx = !this.rtIdx;
    this.positionMaterial.uniforms.tPosition.value = input;
    this.positionMaterial.uniforms.tForces.value = this.rt2;
    this.renderer.render(this.positionScene, this.camera, output);
    this.output = output;
    this.particles.material.uniforms.tPosition.value = output;
    this.lines.material.uniforms.tPosition.value = output;

    // Update texture position uniforms
    for(var i = 0; i < this.textNodes.length; i++){
      this.textNodes[i].updatePositionTexture(output);
    }
  }

  /**
   * Create edges (lines)
   * Based on shadermaterial. Edges, their location will be calculated on GPU
   */
  Proto.setupLines = function () {
    // Choose vertex shader depending on directed/undirected colored graph
    if(!this.typed) {
      var vs = [
        'uniform sampler2D tPosition;',
        'uniform vec3 fPos;', // Finger Position
        'attribute vec2 color;',
        'attribute vec3 customColor;',
        'attribute float opacity;',
        'varying float vDistance;',
        'varying vec3 vColor;',
        'varying float vOpac;',
        'void main(){',
        '  vOpac = opacity;',
        '  vec4 pos =  vec4( texture2D(tPosition, color.xy).xyz, 1.0 );',
        '  vDistance = length(fPos.xyz - pos.xyz);',
        '  vColor = mix(vec3(0.3,0.3,1), vec3(1.,0.3,0.3), position.x);',
        '  vec4 mvPosition = modelViewMatrix * pos;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '}'
      ].join('\n');
    }
    else {
      var vs = [
        'uniform sampler2D tPosition;',
        'uniform vec3 fPos;', // Finger Position
        'attribute vec2 color;',
        'attribute vec3 customColor;',
        'attribute float opacity;',
        'varying float vDistance;',
        'varying vec3 vColor;',
        'varying float vOpac;',
        'void main(){',
        '  vColor = customColor;',
        '  vOpac = opacity;',
        '  vec4 pos =  vec4( texture2D(tPosition, color.xy).xyz, 1.0 );',
        '  vDistance = length(fPos.xyz - pos.xyz);',
        '  vec4 mvPosition = modelViewMatrix * pos;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '}'
      ].join('\n');
    }

    var fs = [
      'varying float vDistance;',
      'varying vec3 vColor;',
      'varying float vOpac;',
      'void main(){',
      '  gl_FragColor = vec4(vColor, vOpac);',//vUv.x)
      // '  gl_FragColor.a *= max( 0.3 , (1.0 - vDistance/200.0 ) );',
      '}'
    ].join('\n');

    var attributes = {
        opacity: { type: 'f', value: null },
        customColor: { type: 'c', value: null }
    }; 
    var lineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPosition: {
          type: 't',
          value: null
        }
      },
      attributes: attributes,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: true,
      depthTest: true,
      vertexShader: vs,
      fragmentShader: fs
    });

    var geometry = new THREE.BufferGeometry();
    geometry.addAttribute('position', Float32Array, this.edgeCount * 2, 3);
    geometry.addAttribute('color', Float32Array, this.edgeCount * 2, 2);
    geometry.addAttribute('customColor', Float32Array, this.edgeCount * 2, 3);
    geometry.addAttribute('opacity', Float32Array, this.edgeCount * 2, 1 );
    geometry.attributes.opacity.dynamic = true;

    // Set initial color, opacity of edges
    var colorA = new THREE.Color(0xff9900);
    var colorB = new THREE.Color(0x99ff00);
    var values_color = geometry.attributes.customColor.array;
    var values_opacity = geometry.attributes.opacity.array;
    for(var v = 0; v < this.edgeCount; v++) {
      // Set opacity for both src and dst (to same val)
      values_opacity[ v * 2 ] = 0.5;
      values_opacity[ v * 2 + 1] = 0.5;

      // color.setHSL( 0.0 + 0.1 * (v / this.edgeCount), 0.9, 0.1 );
      srcColor = this.edges[v].srcColor;
      dstColor = this.edges[v].dstColor;

      // Set color for both src and dst (to same val)
      values_color[ v * 6 + 0 ] = srcColor.r;
      values_color[ v * 6 + 1 ] = srcColor.g;
      values_color[ v * 6 + 2 ] = srcColor.b;
      values_color[ v * 6 + 3 ] = dstColor.r;
      values_color[ v * 6 + 4 ] = dstColor.g;
      values_color[ v * 6 + 5 ] = dstColor.b;
    }

    var attrs = geometry.attributes.position.array;
    for (var i = 0; i < attrs.length; i += 3) {
      attrs[i] = (i / 3) % 2;
    }

    lineMaterial.index0AttributeName = 'color';
    lineMaterial.linewidth = 1;

    geometry.attributes.color.array = this.geometry.attributes.color.array;

    this.lines = new THREE.Line(geometry, lineMaterial, THREE.LinePieces);
    this.scene.add(this.lines);
  }

  /**
   * Create nodes (particles)
   * Based on shadermaterial. Nodes, their location will be calculated on GPU
   */
  Proto.setupParticles = function () {
    var geometry = new THREE.BufferGeometry();
    var positions = new Float32Array(this.nodeCount * 3);
    var n = {};
    for (var i = 0; i < this.nodeCount; i++) {
      this.getIndices(i, n);
      positions[i * 3] = n.x;
      positions[i * 3 + 1] = n.y;
      positions[i * 3 + 2] = 0;
    }
    geometry.addAttribute('position', Float32Array, positions, 3);


    var vs = [
      //'attri
      'uniform float size;',
      'uniform float scale;',
      'uniform vec3  fPos;',
      'uniform sampler2D tPosition;',
      'varying float vDistance;',
  		'void main()	{',
      '   vec3 pos = texture2D(tPosition, position.xy).xyz;',
      '   vDistance = length(pos - fPos);',
      '	  vec4 mvPosition = modelViewMatrix * vec4(pos , 1.0);',
      // '   gl_PointSize = size * (scale / length(mvPosition.xyz));',
      '   gl_PointSize = size;',
		  '	  gl_Position = projectionMatrix * mvPosition;',
  		'}'].join('\n');

    var fs = [
      'varying float vDistance;',
      'uniform sampler2D map;',
      'void main()	{',
      '  gl_FragColor = texture2D(map, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y));',
      // '  gl_FragColor.a *= max(0.3 , (1.0 - vDistance/200.0));',
      '}'
    ].join('\n');

    var material = new THREE.ShaderMaterial({
      uniforms: {
        size: {
          type: 'f',
          value: 20
        },
        scale: {
          type: 'f',
          value: 1000.0
        },
        tPosition: {
          type: 't',
          value: null
        }
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      vertexShader: vs,
      fragmentShader: fs
    });

    this.particles = new THREE.ParticleSystem(geometry, material);
    this.scene.add(this.particles);
  }

  /**
   * Creates and returns a deep copy of the texture of given input
   */
  Proto.copyTexture = function (input, output) {
    this.copyMaterial.uniforms.texture.value = input;
    this.renderer.render(this.copyScene, this.camera, output)
  };

  /**
   * Positionshader
   */
  Proto.setupPositionShader = function (fragmentShader) {
    var vs = [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4(position, 1.0);',
      '}'
    ].join('\n');

    fragmentShader = fragmentShader.replace(/\$\{WIDTH\}/g, this.tWidth);
    fragmentShader = fragmentShader.replace(/\$\{HEIGHT\}/g, this.tHeight);

    this.positionScene = new THREE.Scene();
    this.positionMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPosition: { type: "t", value: null },
        tForces: { type: "t", value: null },
        strength: { type: 'f', value: this.vertexForce }
      },
      vertexShader: vs,
      fragmentShader: fragmentShader
    });

    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.positionMaterial);
    this.positionScene.add(mesh);
  }

  /**
   * Forcesshader
   */
  Proto.setupForcesShader = function (vertextShaderText, fragmentShaderText) {
    this.forceMaterial = new THREE.ShaderMaterial({
      attributes: {
          weight: { type: 'f', value: null }
      },
      uniforms: {
        firstVertex: { type: 'f', value: 1 },             
        density: { type: 'f', value: this.edgeForce },
        texture1: { type: 't', value: null }
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      vertexShader: vertextShaderText,
      fragmentShader: fragmentShaderText
    });

    this.geometry = new THREE.BufferGeometry();
    this.geometry.addAttribute('position', Float32Array, this.edgeCount, 3);
    this.geometry.addAttribute('color', Float32Array, this.edgeCount, 4);
    this.geometry.addAttribute('weight', Float32Array, this.edgeCount, 1);
    this.geometry.attributes.weight.dynamic = true;
  
    // Take edge weight into consideration with calculated forces
    // Get max val first (to normalize)
    max_val = 0;
    for (i = 0; i < this.edges.length; i++) {
      var v = this.edges[i].val
      if(max_val < v) {
        max_val = v;
      }
    }
    // Calculate edge weight
    var values_weight = this.geometry.attributes.weight.array;
    for(var v = 0; v < this.edgeCount; v++) {
      values_weight[v] = 1 + 10*((this.edges[v].val / max_val));    // Weight between 1 and 1+10 depending on value. TODO 10 is magic number, make configurable
    }

    this.forceScene = new THREE.Scene();

    var mesh = new THREE.ParticleSystem(this.geometry, this.forceMaterial);

    this.forceScene.add(mesh);
  }

  /**
   * Dimensions
   */
  Proto.setDimensions = function (w, h) {
    this.tWidth = w;
    this.tHeight = h;
    this.twInv = 1 / w;
    this.thInv = 1 / h;
    this.twOff = 1 / (w * 2);
    this.thOff = 1 / (h * 2);
  }

  /**
   * Set initial edge location, weight, colors
   */
  Proto.populateEdgeGeometry = function () {
    var node_ids = this.geometry.attributes.color.array;
    var weights = this.geometry.attributes.weight.array;
    var n = {};

    for (i = 0; i < this.edges.length; i++) {
      this.getIndices(this.edges[i].src, n);
      node_ids[i * 4 + 0] = n.x;
      node_ids[i * 4 + 1] = n.y;

      this.getIndices(this.edges[i].dst, n);
      node_ids[i * 4 + 2] = n.x;
      node_ids[i * 4 + 3] = n.y;
    }
    // this.edges = null;
  }

  /**
   * Return x,y for given nodeId (in n)
   */
  Proto.getIndices = function (nodeId, n) {
    n = n || {};
    n.x = (nodeId % this.tWidth) * this.twInv + this.twOff;
    n.y = Math.floor(nodeId / this.tWidth) * this.thInv + this.thOff;
    return n;
  }

  /**
   * Return node id for given indices (x,y)
   */
  Proto.getNodeId = function (x, y) {
    x = Math.round((x - this.twOff) * this.tWidth);
    y = Math.round((y - this.thOff) * this.tHeight);
    // console.log(y * this.tWidth + x)
    return y * this.tWidth + x;
  }

  /**
   * Copyshader
   */
  Proto.setupCopyShader = function () {
    var vs = [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4(position, 1.0);',
      '}'
    ].join('\n');

    var fs = [
      'uniform sampler2D texture;',
      'varying vec2 vUv;',
      'void main() {',
      '  gl_FragColor = texture2D(texture, vUv);',
      '}'
    ].join('\n');

    this.copyScene = new THREE.Scene();
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        texture: {
          type: "t",
          value: null
        },
      },
      vertexShader: vs,
      fragmentShader: fs
    });

    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial);
    this.copyScene.add(mesh);
  };
  
  /**
   * Node text
   */
  Proto.setupText = function(){
    for(var i = 0, l = this.nodes.length; i < l; i++) {
      var mesh = this.createText(this.nodes[i] , i);
      this.scene.add(mesh);
    }
  }
  
  /**
   * Create scene used by GPU picker. Add a node for each node in the graph ('clickable')
   */
  Proto.setupPicker = function(){
    for(var i = 0, l = this.nodes.length; i < l; i++) {
      var mesh = this.createPickerNode(i);
      this.pickingScene.add(mesh);
    }
  }

  /**
   * Create a 'clickable' node for the scene used by GPU picker.
   * It's placed on the exact same location as the nodes in the main scene
   * It's color is based on the id
   */
  Proto.createPickerNode = function(id){

    var mesh      = this.textCreator.createPickerMesh();
    var n         = this.getIndices(id);
    var uv        = new THREE.Vector2(n.x , n.y);

    var uniforms  = {
      tPosition:{type:"t",value:null},
      uvPos:{type:"v2",value:uv}
    }

    var vertShader = [
      'uniform vec2 uvPos;',
      'uniform sampler2D tPosition;',
      'varying vec3 vColor;',
      'varying vec2 vUv;',

      'void main(){',
      '   vColor = color;',
      '   vUv = uv;',
      '   vec3 pos = texture2D(tPosition , uvPos).xyz;',
      '   vec4 mvPosition = modelViewMatrix * vec4(position , 1.0);',
      '   vec4 mvPos = modelViewMatrix * vec4(pos , 1.0);',
      '   vec4 a = mvPos + vec4(position , 1.0);',
    '   gl_Position = projectionMatrix * a;',

      '}'
    ].join("\n");

    var fragShader = [
      'varying vec2 vUv;',
      'varying vec3 vColor;',

      'void main(){',
        '   vec4 c = vec4(vColor.xyz, 1.0);',
        '   gl_FragColor = c;',
      '}'
    ].join("\n");


    var material = new THREE.ShaderMaterial({
      vertexColors: THREE.VertexColors,
      uniforms:uniforms,
      vertexShader:vertShader,
      fragmentShader:fragShader,
      side: THREE.DoubleSide,
      transparent:false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    var m = mesh.clone();

    m.material = material;
    m.material.needsUpdate = true;
    m.id = id;
    m.uv = uv;

    color = this.intToColor(id);
    for(f in m.geometry.faces){
      m.geometry.faces[f].vertexColors[0] = color;
      m.geometry.faces[f].vertexColors[1] = color;
      m.geometry.faces[f].vertexColors[2] = color;
    }

    m.updatePositionTexture = function(t){
      this.material.uniforms.tPosition.value = t;
      this.material.needsUpdate = true;
    }
    this.textNodes.push(m);
    return m;
  };

  /**
   * Return color from given value (nodeId)
   * Note: 0,0,0 (black) is not used due to background color
   */
  Proto.intToColor = function(value){
    bgrValue = value + 1;     // Due to color 0 0 0 being node 0. Now 0 0 0 is not in use
    blueMask = 0xFF0000, greenMask = 0xFF00, redMask = 0xFF;
    a = ((bgrValue & blueMask) >> 16);
    b = ((bgrValue & redMask));
    c = ((bgrValue & greenMask) >> 8);
    return new THREE.Color('rgb('+a+','+b+','+c+')');
  };

  /**
   * Return nodeId from given r,g,b values
   */
  Proto.colorToInt = function(r, g, b){
    bgrValue = (r << 16) + (b << 8) + g;
    offset = bgrValue - 1; // Due to color 0 0 0 being node 0. Now 0 0 0 is not in use
    return offset;
  };

  /**
   * Returns node id's indegree
   */ 
  Proto.inDegree = function(nid){
    indegree = 0;
    for(var i=0; i<this.edges.length; i++) {
      if(this.edges[i].dst == nid) {
        indegree++;
      }
    }
    return indegree;
  }

  /**
   * Returns node id's outdegree
   */ 
  Proto.outDegree = function(nid){
    outdegree = 0;
    for(var i=0; i<this.edges.length; i++) {
      if(this.edges[i].src == nid) {
        outdegree++;
      }
    }
    return outdegree;
  }

  /**
   * Returns array of node id's to which this node (nid) is connected
   */ 
  Proto.edgesConnectedTo = function(nid){
    res = [];

    // Quick and dirty way to get nodes connected to this node (nid)
    for(var i=0; i<this.edges.length; i++) {
      if(this.edges[i].src == nid) {
        res.push({'edge': i, 'node': this.edges[i].dst});
      }
      else if (this.edges[i].dst == nid) {
        res.push({'edge': i, 'node': this.edges[i].src});
      }
    }
    return res;
  };

  /**
   * Starting from nid, with opacity, change in Values 
   * opacity the opacity of connected nodes to given depth
   */
  Proto.recursiveHighlight = function(values_opacity, nid, opacity, depth) {
    // console.log(values_opacity)
    // connectedTo = this.edgesConnectedTo(nid);
    // for(var v = 0; v < connectedTo.length; v++) {
    //   // console.log('v',v)
    //   curr = connectedTo[v];
    //   // if(values_opacity[curr.edge*2] == undefined) {
    //     // console.log('x')
    //     values_opacity[curr.edge*2] = opacity;
    //     values_opacity[curr.edge*2+1] = opacity;

    //     if(depth > 0) {
    //       // console.log('y')
    //       new_values = this.recursiveHighlight(values_opacity, curr.node, (opacity/2), (depth-1));
    //       for(var i in new_values) {
    //         if(values_opacity[i] == undefined || values_opacity[i] < new_values[i]) {
    //           values_opacity[i] = new_values[i]
    //         }
    //       }
    //     }
    //   // }
    // }
    // return values_opacity;
    traversed = [];
    connectedTo = this.edgesConnectedTo(nid);
    for(var v = 0; v < connectedTo.length; v++) {
      curr = connectedTo[v];
      values_opacity[curr.edge*2] = 1.0;
      values_opacity[curr.edge*2+1] = 1.0;
      traversed.push(curr.edge);
      connectedTo2 = this.edgesConnectedTo(curr.node);
      for(var w = 0; w < connectedTo2.length; w++) {
        currentLevelOpacity = 0.4;
        curr2 = connectedTo2[w];
        if(traversed.indexOf(curr2.edge) == -1
          && values_opacity[curr2.edge*2] < (currentLevelOpacity*0.99)
          && values_opacity[curr2.edge*2+1] < (currentLevelOpacity*0.99)) {
          values_opacity[curr2.edge*2] = currentLevelOpacity;
          values_opacity[curr2.edge*2+1] = currentLevelOpacity;
        }
      }
      //TODO make recursive. This should work, there are some issues in combination with threejs
      // if(depth > 0) {
      //   this.recursiveHighlight(values_opacity, curr.node, opacity/2, (depth-1));
      // }
    }
  };

  /**
   * Highlights given node in graph
   * Edges and labels further away will be less visible
   */
  Proto.highlight = function(nid, reset=false){
    // Highlight all edges connected to this node.
    var values_opacity = this.lines.geometry.attributes.opacity.array;
    if(nid != undefined 
      && nid <= values_opacity.length/2) {
      console.log("highlighting: "+nid)

      // Reset highlight when required
      if(reset || !this.selecting) {
        for(var v = 0; v < values_opacity.length/2; v++) {
            values_opacity[v*2] = 0.15;
            values_opacity[v*2+1] = 0.15;
        }
      }

      // Set selecting
      this.selecting = true;

      // Get and highlight all connected edges
      this.recursiveHighlight(values_opacity, nid, 1.0, 1);
      this.lines.geometry.attributes.opacity.needsUpdate = true;
    }
  };

  /**
   * Resets graph back to non highlight state
   */
  Proto.resetHighlight = function() {
    console.log("resetting highlight")
    var values_opacity = this.lines.geometry.attributes.opacity.array;
    for(var v = 0; v < values_opacity.length/2; v++) {
      values_opacity[v*2] = 0.5;
      values_opacity[v*2+1] = 0.5;
    }
    this.lines.geometry.attributes.opacity.needsUpdate = true;
  }

  /**
   * Unhighlights given node (if highlighted)
   */
  Proto.resetHighlightForNode = function(nid) {
    console.log("TODO")
  }

  /**
   * Creates a Mesh that will be placed at a certain point using a uv
   * and a texture full of positions
   */
  Proto.createText = function(text , id){
    var mesh      = this.textCreator.createMesh(text);
    var n        = this.getIndices(id);
    var uv        = new THREE.Vector2(n.x , n.y);
    var texture = mesh.material.map;
    var uniforms  = {
      tPosition:{type:"t",value:null},
      texture:{type:"t",value:texture},
      uvPos:{type:"v2",value:uv}
    }

    var vertShader = [
      'uniform vec2 uvPos;',
      'uniform sampler2D tPosition;',
      'varying vec2 vUv;',

      'void main(){',
      '   vUv = uv;',
      '   vec3 pos = texture2D(tPosition , uvPos).xyz;',
      '	  vec4 mvPosition = modelViewMatrix * vec4(position , 1.0);',
      '   vec4 mvPos = modelViewMatrix * vec4(pos , 1.0);',
      '   vec4 a = mvPos + vec4(position , 1.0);',
	  '	  gl_Position = projectionMatrix * a;',
      '}'
    ].join("\n");

    var fragShader = [
      'uniform sampler2D texture;',
      'varying vec2 vUv;',

      'void main(){',
        '	  vec4 c = texture2D(texture , vUv);',
        '     gl_FragColor = vec4(.5 , vUv.x , vUv.y , .5);',
        '	  gl_FragColor = c;',
      '}'
    ].join("\n");


    var material = new THREE.ShaderMaterial({
      uniforms:uniforms,
      vertexShader:vertShader,
      fragmentShader:fragShader,
      side: THREE.DoubleSide,
      transparent:true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    var m = mesh.clone();
    m.material = material;
    m.material.needsUpdate = true;
    m.id = id;
    m.uv = uv;

    m.updatePositionTexture = function(t){
      this.material.uniforms.tPosition.value = t;
      this.material.needsUpdate = true;
    }
    this.textNodes.push(m);
    return m;
  }

  /**
   * Creates new rendertarget with standard settings
   */
  function getRenderTarget(width, height) {
    var renderTarget = new THREE.WebGLRenderTarget(width, height, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      stencilBuffer: false
    });

    return renderTarget;
  }

  /**
   * Used on scene init, placeholder texture
   */
  function getRandomTexture(w, h, c) {
    var x, y, z, l = w * h;
    var a = new Float32Array(l * 4);
    for (var k = 0; k < c; k++) {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
      // z = 0;

      a[k * 4 + 0] = x;
      a[k * 4 + 1] = y;
      a[k * 4 + 2] = z;
      a[k * 4 + 3] = 1;
    }

    var texture = new THREE.DataTexture(a, w, h, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    texture.flipY = false;

    return texture;
  }

  /**
   * Returns required texture size (for node text)
   */
  function getTextureSize(num) {
    var w = 1,
        h = 1;

    while (h * w < num) {
      w *= 2;
      if (h * w >= num) break;
      h *= 2;
    }
    return [w, h];
  }

}());
