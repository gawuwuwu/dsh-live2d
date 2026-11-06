// Cubism 4.2+ per-drawable MultiplyColor / ScreenColor compatibility for
// pixi-live2d-display 0.4.x. The Core already exposes the colors, but the
// renderer shipped in 0.4.0 never uploads them to its shaders.
(function installCubism4ColorCompatibility(global) {
  'use strict'

  const live2d = global?.PIXI?.live2d
  const Shader = live2d?.CubismShader_WebGL
  const Renderer = live2d?.CubismRenderer_WebGL
  if (!Shader || !Renderer || Shader.__multiplyScreenPatched) return false

  const fragmentSetupMask = live2d.fragmentShaderSrcsetupMask
  const vertex = live2d.vertexShaderSrc
  const vertexMasked = live2d.vertexShaderSrcMasked

  const colorTransform = `
    color.rgb = color.rgb * u_multiplyColor.rgb;
    color.rgb = color.rgb + u_screenColor.rgb * color.a - color.rgb * u_screenColor.rgb;
  `
  const fragment = `
    precision mediump float;
    varying vec2 v_texCoord;
    uniform vec4 u_baseColor;
    uniform vec4 u_multiplyColor;
    uniform vec4 u_screenColor;
    uniform sampler2D s_texture0;
    void main() {
      vec4 color = texture2D(s_texture0, v_texCoord);
      ${colorTransform}
      gl_FragColor = color * u_baseColor;
    }
  `
  const fragmentMasked = `
    precision mediump float;
    varying vec2 v_texCoord;
    varying vec4 v_clipPos;
    uniform vec4 u_baseColor;
    uniform vec4 u_multiplyColor;
    uniform vec4 u_screenColor;
    uniform vec4 u_channelFlag;
    uniform sampler2D s_texture0;
    uniform sampler2D s_texture1;
    void main() {
      vec4 color = texture2D(s_texture0, v_texCoord);
      ${colorTransform}
      color = color * u_baseColor;
      vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;
      float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
      gl_FragColor = color * maskVal;
    }
  `
  const fragmentMaskedInverted = `
    precision mediump float;
    varying vec2 v_texCoord;
    varying vec4 v_clipPos;
    uniform vec4 u_baseColor;
    uniform vec4 u_multiplyColor;
    uniform vec4 u_screenColor;
    uniform vec4 u_channelFlag;
    uniform sampler2D s_texture0;
    uniform sampler2D s_texture1;
    void main() {
      vec4 color = texture2D(s_texture0, v_texCoord);
      ${colorTransform}
      color = color * u_baseColor;
      vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;
      float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;
      gl_FragColor = color * (1.0 - maskVal);
    }
  `

  Shader.prototype.generateShaders = function generateShaders() {
    this._shaderSets = Array.from({ length: 10 }, () => ({}))
    this._shaderSets[0].shaderProgram = this.loadShaderProgram(live2d.vertexShaderSrcSetupMask, fragmentSetupMask)
    this._shaderSets[1].shaderProgram = this.loadShaderProgram(vertex, fragment)
    this._shaderSets[2].shaderProgram = this.loadShaderProgram(vertexMasked, fragmentMasked)
    this._shaderSets[3].shaderProgram = this.loadShaderProgram(vertexMasked, fragmentMaskedInverted)
    this._shaderSets[4].shaderProgram = this._shaderSets[1].shaderProgram
    this._shaderSets[5].shaderProgram = this._shaderSets[2].shaderProgram
    this._shaderSets[6].shaderProgram = this._shaderSets[3].shaderProgram
    this._shaderSets[7].shaderProgram = this._shaderSets[1].shaderProgram
    this._shaderSets[8].shaderProgram = this._shaderSets[2].shaderProgram
    this._shaderSets[9].shaderProgram = this._shaderSets[3].shaderProgram

    const setup = this._shaderSets[0]
    setup.attributePositionLocation = this.gl.getAttribLocation(setup.shaderProgram, 'a_position')
    setup.attributeTexCoordLocation = this.gl.getAttribLocation(setup.shaderProgram, 'a_texCoord')
    setup.samplerTexture0Location = this.gl.getUniformLocation(setup.shaderProgram, 's_texture0')
    setup.uniformClipMatrixLocation = this.gl.getUniformLocation(setup.shaderProgram, 'u_clipMatrix')
    setup.uniformChannelFlagLocation = this.gl.getUniformLocation(setup.shaderProgram, 'u_channelFlag')
    setup.uniformBaseColorLocation = this.gl.getUniformLocation(setup.shaderProgram, 'u_baseColor')

    for (let index = 1; index <= 9; index += 1) {
      const set = this._shaderSets[index]
      set.attributePositionLocation = this.gl.getAttribLocation(set.shaderProgram, 'a_position')
      set.attributeTexCoordLocation = this.gl.getAttribLocation(set.shaderProgram, 'a_texCoord')
      set.samplerTexture0Location = this.gl.getUniformLocation(set.shaderProgram, 's_texture0')
      set.uniformMatrixLocation = this.gl.getUniformLocation(set.shaderProgram, 'u_matrix')
      set.uniformBaseColorLocation = this.gl.getUniformLocation(set.shaderProgram, 'u_baseColor')
      set.uniformMultiplyColorLocation = this.gl.getUniformLocation(set.shaderProgram, 'u_multiplyColor')
      set.uniformScreenColorLocation = this.gl.getUniformLocation(set.shaderProgram, 'u_screenColor')
      if (index === 2 || index === 3 || index === 5 || index === 6 || index === 8 || index === 9) {
        set.samplerTexture1Location = this.gl.getUniformLocation(set.shaderProgram, 's_texture1')
        set.uniformClipMatrixLocation = this.gl.getUniformLocation(set.shaderProgram, 'u_clipMatrix')
        set.uniformChannelFlagLocation = this.gl.getUniformLocation(set.shaderProgram, 'u_channelFlag')
      }
    }
  }

  const originalSetupShaderProgram = Shader.prototype.setupShaderProgram
  Shader.prototype.setupShaderProgram = function setupShaderProgram(renderer, ...args) {
    const result = originalSetupShaderProgram.call(this, renderer, ...args)
    if (renderer.getClippingContextBufferForMask?.()) return result

    const index = renderer._live2dDrawableIndex
    const drawables = renderer.getModel?.()?.getModel?.()?.drawables
    if (!Number.isInteger(index) || !drawables?.multiplyColors || !drawables?.screenColors) return result

    const gl = this.gl
    const program = gl.getParameter(gl.CURRENT_PROGRAM)
    if (!this.__colorUniforms) this.__colorUniforms = new WeakMap()
    let locations = this.__colorUniforms.get(program)
    if (!locations) {
      locations = {
        multiply: gl.getUniformLocation(program, 'u_multiplyColor'),
        screen: gl.getUniformLocation(program, 'u_screenColor'),
      }
      this.__colorUniforms.set(program, locations)
    }
    const offset = index * 4
    const multiply = drawables.multiplyColors
    const screen = drawables.screenColors
    if (locations.multiply) {
      gl.uniform4f(locations.multiply, multiply[offset], multiply[offset + 1], multiply[offset + 2], multiply[offset + 3])
    }
    if (locations.screen) {
      gl.uniform4f(locations.screen, screen[offset], screen[offset + 1], screen[offset + 2], screen[offset + 3])
    }
    return result
  }

  // The original doDrawModel() does not pass the drawable index to drawMesh(),
  // so stash it before each draw. setupShaderProgram() above uses it to upload
  // the matching multiply/screen colors.
  Renderer.prototype.doDrawModel = function doDrawModel() {
    this.preDraw()
    if (this._clippingManager != null) {
      this._clippingManager.setupClippingContext(this.getModel(), this)
    }
    const model = this.getModel()
    const drawableCount = model.getDrawableCount()
    const renderOrder = model.getDrawableRenderOrders()
    for (let i = 0; i < drawableCount; i += 1) {
      this._sortedDrawableIndexList[renderOrder[i]] = i
    }
    for (let i = 0; i < drawableCount; i += 1) {
      const drawableIndex = this._sortedDrawableIndexList[i]
      if (!model.getDrawableDynamicFlagIsVisible(drawableIndex)) continue
      this._live2dDrawableIndex = drawableIndex
      this.setClippingContextBufferForDraw(
        this._clippingManager != null
          ? this._clippingManager.getClippingContextListForDraw()[drawableIndex]
          : null,
      )
      this.setIsCulling(model.getDrawableCulling(drawableIndex))
      this.drawMesh(
        model.getDrawableTextureIndices(drawableIndex),
        model.getDrawableVertexIndexCount(drawableIndex),
        model.getDrawableVertexCount(drawableIndex),
        model.getDrawableVertexIndices(drawableIndex),
        model.getDrawableVertices(drawableIndex),
        model.getDrawableVertexUvs(drawableIndex),
        model.getDrawableOpacity(drawableIndex),
        model.getDrawableBlendMode(drawableIndex),
        model.getDrawableInvertedMaskBit(drawableIndex),
      )
    }
  }

  Shader.__multiplyScreenPatched = true
  return true
})(window)
