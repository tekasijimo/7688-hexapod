var _modeTable = {
  modeAdjust: "adj",
  modeStop: "s",
  modeDance1: "d1",
  modeDance2: "d2",
  modeDance3: "d3",
  modeDemo: "demo",
  modeFwd: "fwd",
  modeBwd: "bwd",
  modeTurnLeft: "tl",
  modeTurnRight: "tr",
  modeShiftLeft: "sl",
  modeShiftRight: "sr",
}

var DEBUG = false
var DEBUG_EMU = false

var settings = require("./settings.js")

// ==========================================================================
// low level HW control

if(!DEBUG_EMU) {
  var mraa = require("mraa")
  var pwms = new mraa.I2c(0)
  var pwm0 = new mraa.Pwm(18)
  var pwm1 = new mraa.Pwm(19)
  var pGood = new mraa.Gpio(0)
  var pError = new mraa.Gpio(1)

  pwms.address(0x40)
  pwms.writeReg(0, 0x10)
  pwms.writeReg(0xFE, 83) // 81Hz, ~12.3ms, ~3us per unit
  pwms.writeReg(0, 0x0)

  pwm0.period_ms(10)
  pwm0.enable(true)
  pwm1.period_ms(10)
  pwm1.enable(true)

  pGood.dir(0)
  pGood.write(0)
  pError.dir(0)
  pError.write(0)
}

// pin = 0~17
// value = us
function writePwm(pin, value)
{
  if(DEBUG_EMU)
    return
  if(pin < 16)
  {
    var r
    value = parseInt(value / 3);
    r = pwms.writeReg(6+pin*4, 0);
    if(r != 0)
    {
      pGood.write(0)
      pError.write(1)
      throw "<** PANIC **> failed to write PWM to I2C device!!!"
    }
    pwms.writeReg(7+pin*4, 0);
    pwms.writeReg(8+pin*4, value & 0xFF);
    pwms.writeReg(9+pin*4, (value>>8) & 0xFF);
  }
  else if(pin == 16)
  {
    pwm0.pulsewidth_us(value)
  }
  else if(pin == 17)
  {
    pwm1.pulsewidth_us(value)
  }
}

// ==========================================================================
// middleware
//
//  coordinates:
//    x: >0=left, <0=right 
//    y: >0=front, <0=back
//    z: >0=height
//    origin = body center


// x, y, z coordinates of nodes of each leg 
var legCenters = [
  [40.36, 70.36, 0],
  [55.25, 0, 0],
  [40.36, -70.36, 0],
  [-40.36, -70.36, 0],
  [-55.25, 0, 0],
  [-40.36, 70.36, 0],
];

var legAngles = [45, 0, 315, 225, 180, 135]

// default x, y, z coordinates of tips of each leg 
var legTipsDefault = [
  [95.52, 125.52, -62, 1],
  [133.25, 0, -62, 1],
  [95.52, -125.52, -62, 1],
  [-95.52, -125.52, -62, 1],
  [-133.25, 0, -62, 1],
  [-95.52, 125.52, -62, 1],
];

// "current" x, y, z coordinates of tips of each leg 
var legTipsLoc = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

// return angles 0, 1, 2 of specified "leg" for its tip to reach specified "location"
// return null if impossible
function loc2angles(leg, loc)
{
  const a = 42, b = 84, c = 36

  // shift origin to leg center
  x = loc[0] - legCenters[leg][0]
  y = loc[1] - legCenters[leg][1]
  z = loc[2] - legCenters[leg][2]

  a0 = (180/Math.PI)*Math.atan(y/x) - legAngles[leg]
  if(x<0)
    a0 += 180
  else if(y<0)
    a0 += 360
  if(a0 > 180)
    a0 -= 360

  xp = Math.sqrt(x*x+y*y)-c
  yp = z

  lr = Math.sqrt(xp*xp+yp*yp)
  ar = (180/Math.PI)*Math.asin(yp/lr)
  at = (180/Math.PI)*Math.acos((lr*lr + a*a - b*b)/(2*a*lr))
  az = (180/Math.PI)*Math.acos((lr*lr - a*a + b*b)/(2*b*lr))
  a1 = at + ar
  a2 = 180 - at - az

  if(0) {
    console.log("\nxyz = " + x + "," + y + "," + z)
    console.log("len of reach = " + lr)
    console.log("angle of reach = " + ar)
    console.log("angle1 = " + at)
    console.log("angle2 = " + az)
    console.log("result = " + a0 + "," + a1 + "," + a2)
  }

  return [a0, a1, a2]
}

// nonblockingly move tip of specified "leg" to specified "location"
// return true if ok
// return false if impossible
function moveLeg(leg, loc)
{
  a = loc2angles(leg, loc)

  if(a[0] <= 45 && a[0] >= -45 &&
      a[1] <= 90 && a[1] >= -90 &&
      a[2] <= 150 && a[2] >= 36)
  {
    writePwm(settings.pinMap[leg][0], settings.pinDefaultPWM[leg][0] + a[0] * 500 / 45)
    writePwm(settings.pinMap[leg][1], settings.pinDefaultPWM[leg][1] - a[1] * 500 / 45)
    writePwm(settings.pinMap[leg][2], settings.pinDefaultPWM[leg][2] + (a[2]-90) * 500 / 45)  
    legTipsLoc[leg][0] = loc[0]
    legTipsLoc[leg][1] = loc[1]
    legTipsLoc[leg][2] = loc[2]
  }
  else
  {
    console.log("moveLeg failed: " + leg + "," + loc + "," + a)
    return false
  }

  return true;
}

// return current tip location (in x, y, z) of specified "location"
function getLegsLoc(leg)
{
  return legTipsLoc[leg].slice(0, 3)
}

// ==========================================================================
// high level control
//

function _adjust(leg, time, params, loc) {

  loc[0] = 0
  loc[1] = 0
  loc[2] = -20

  return time
}

function _stop(leg, time, params, loc) {

  loc[0] = 0
  loc[1] = 0
  loc[2] = 0

  return time
}

// Forward/backward waving
var _danceTable1 = [
  [[0.00, -12.00, 0.00],[0.00, -13.72, -3.46],[0.00, -15.02, -6.76],[0.00, -15.82, -9.83],[0.00, -16.08, -12.59],[0.00, -15.75, -14.95],[0.00, -14.83, -16.84],[0.00, -13.31, -18.17],[0.00, -11.24, -18.87],[0.00, -8.69, -18.89],[0.00, -5.74, -18.16],[0.00, -2.53, -16.69],[0.00, 0.79, -14.47],[0.00, 4.06, -11.57],[0.00, 7.12, -8.09],[0.00, 9.81, -4.18],[0.00, 12.00, 0.00],[0.00, 13.60, 4.24],[0.00, 14.56, 8.32],[0.00, 14.87, 12.05],[0.00, 14.53, 15.24],[0.00, 13.62, 17.74],[0.00, 12.19, 19.47],[0.00, 10.34, 20.35],[0.00, 8.15, 20.40],[0.00, 5.71, 19.64],[0.00, 3.10, 18.14],[0.00, 0.40, 16.01],[0.00, -2.33, 13.35],[0.00, -5.01, 10.31],[0.00, -7.57, 6.99],[0.00, -9.92, 3.51],],
  [[0.00, -12.00, 0.00],[0.00, -13.66, 0.39],[0.00, -14.79, 0.78],[0.00, -15.34, 1.11],[0.00, -15.31, 1.32],[0.00, -14.68, 1.40],[0.00, -13.51, 1.32],[0.00, -11.83, 1.09],[0.00, -9.70, 0.76],[0.00, -7.20, 0.38],[0.00, -4.42, -0.01],[0.00, -1.46, -0.34],[0.00, 1.56, -0.56],[0.00, 4.54, -0.63],[0.00, 7.34, -0.55],[0.00, 9.86, -0.33],[0.00, 12.00, 0.00],[0.00, 13.66, 0.39],[0.00, 14.79, 0.78],[0.00, 15.34, 1.11],[0.00, 15.31, 1.32],[0.00, 14.68, 1.40],[0.00, 13.51, 1.32],[0.00, 11.83, 1.09],[0.00, 9.70, 0.76],[0.00, 7.20, 0.38],[0.00, 4.42, -0.01],[0.00, 1.46, -0.34],[0.00, -1.56, -0.56],[0.00, -4.54, -0.63],[0.00, -7.34, -0.55],[0.00, -9.86, -0.33],],
  [[0.00, -12.00, 0.00],[0.00, -13.60, 4.24],[0.00, -14.56, 8.32],[0.00, -14.87, 12.05],[0.00, -14.53, 15.24],[0.00, -13.62, 17.74],[0.00, -12.19, 19.47],[0.00, -10.34, 20.35],[0.00, -8.15, 20.40],[0.00, -5.71, 19.64],[0.00, -3.10, 18.14],[0.00, -0.40, 16.01],[0.00, 2.33, 13.35],[0.00, 5.01, 10.31],[0.00, 7.57, 6.99],[0.00, 9.92, 3.51],[0.00, 12.00, 0.00],[0.00, 13.72, -3.46],[0.00, 15.02, -6.76],[0.00, 15.82, -9.83],[0.00, 16.08, -12.59],[0.00, 15.75, -14.95],[0.00, 14.83, -16.84],[0.00, 13.31, -18.17],[0.00, 11.24, -18.87],[0.00, 8.69, -18.89],[0.00, 5.74, -18.16],[0.00, 2.53, -16.69],[0.00, -0.79, -14.47],[0.00, -4.06, -11.57],[0.00, -7.12, -8.09],[0.00, -9.81, -4.18],],
  [[0.00, -12.00, 0.00],[0.00, -13.60, 4.24],[0.00, -14.56, 8.32],[0.00, -14.87, 12.05],[0.00, -14.53, 15.24],[0.00, -13.62, 17.74],[0.00, -12.19, 19.47],[0.00, -10.34, 20.35],[0.00, -8.15, 20.40],[0.00, -5.71, 19.64],[0.00, -3.10, 18.14],[0.00, -0.40, 16.01],[0.00, 2.33, 13.35],[0.00, 5.01, 10.31],[0.00, 7.57, 6.99],[0.00, 9.92, 3.51],[0.00, 12.00, 0.00],[0.00, 13.72, -3.46],[0.00, 15.02, -6.76],[0.00, 15.82, -9.83],[0.00, 16.08, -12.59],[0.00, 15.75, -14.95],[0.00, 14.83, -16.84],[0.00, 13.31, -18.17],[0.00, 11.24, -18.87],[0.00, 8.69, -18.89],[0.00, 5.74, -18.16],[0.00, 2.53, -16.69],[0.00, -0.79, -14.47],[0.00, -4.06, -11.57],[0.00, -7.12, -8.09],[0.00, -9.81, -4.18],],
  [[0.00, -12.00, 0.00],[0.00, -13.66, 0.39],[0.00, -14.79, 0.78],[0.00, -15.34, 1.11],[0.00, -15.31, 1.32],[0.00, -14.68, 1.40],[0.00, -13.51, 1.32],[0.00, -11.83, 1.09],[0.00, -9.70, 0.76],[0.00, -7.20, 0.38],[0.00, -4.42, -0.01],[0.00, -1.46, -0.34],[0.00, 1.56, -0.56],[0.00, 4.54, -0.63],[0.00, 7.34, -0.55],[0.00, 9.86, -0.33],[0.00, 12.00, 0.00],[0.00, 13.66, 0.39],[0.00, 14.79, 0.78],[0.00, 15.34, 1.11],[0.00, 15.31, 1.32],[0.00, 14.68, 1.40],[0.00, 13.51, 1.32],[0.00, 11.83, 1.09],[0.00, 9.70, 0.76],[0.00, 7.20, 0.38],[0.00, 4.42, -0.01],[0.00, 1.46, -0.34],[0.00, -1.56, -0.56],[0.00, -4.54, -0.63],[0.00, -7.34, -0.55],[0.00, -9.86, -0.33],],
  [[0.00, -12.00, 0.00],[0.00, -13.72, -3.46],[0.00, -15.02, -6.76],[0.00, -15.82, -9.83],[0.00, -16.08, -12.59],[0.00, -15.75, -14.95],[0.00, -14.83, -16.84],[0.00, -13.31, -18.17],[0.00, -11.24, -18.87],[0.00, -8.69, -18.89],[0.00, -5.74, -18.16],[0.00, -2.53, -16.69],[0.00, 0.79, -14.47],[0.00, 4.06, -11.57],[0.00, 7.12, -8.09],[0.00, 9.81, -4.18],[0.00, 12.00, 0.00],[0.00, 13.60, 4.24],[0.00, 14.56, 8.32],[0.00, 14.87, 12.05],[0.00, 14.53, 15.24],[0.00, 13.62, 17.74],[0.00, 12.19, 19.47],[0.00, 10.34, 20.35],[0.00, 8.15, 20.40],[0.00, 5.71, 19.64],[0.00, 3.10, 18.14],[0.00, 0.40, 16.01],[0.00, -2.33, 13.35],[0.00, -5.01, 10.31],[0.00, -7.57, 6.99],[0.00, -9.92, 3.51],],
]

// Left/right waving
var _danceTable2 = [
  [[-12.00, 0.00, 0.00],[-9.91, 0.00, 2.60],[-7.51, 0.00, 5.18],[-4.90, 0.00, 7.69],[-2.15, 0.00, 10.03],[0.65, 0.00, 12.10],[3.42, 0.00, 13.80],[6.07, 0.00, 15.03],[8.52, 0.00, 15.71],[10.70, 0.00, 15.75],[12.51, 0.00, 15.13],[13.87, 0.00, 13.84],[14.72, 0.00, 11.91],[14.98, 0.00, 9.43],[14.62, 0.00, 6.52],[13.62, 0.00, 3.32],[12.00, 0.00, 0.00],[9.82, 0.00, -3.26],[7.17, 0.00, -6.29],[4.17, 0.00, -8.96],[0.97, 0.00, -11.15],[-2.28, 0.00, -12.78],[-5.43, 0.00, -13.83],[-8.33, 0.00, -14.28],[-10.87, 0.00, -14.18],[-12.96, 0.00, -13.56],[-14.51, 0.00, -12.50],[-15.50, 0.00, -11.04],[-15.89, 0.00, -9.27],[-15.71, 0.00, -7.22],[-14.96, 0.00, -4.96],[-13.71, 0.00, -2.54],],
  [[-12.00, 0.00, 0.00],[-9.93, 0.00, 3.75],[-7.58, 0.00, 7.45],[-5.04, 0.00, 10.98],[-2.38, 0.00, 14.21],[0.33, 0.00, 17.01],[3.02, 0.00, 19.26],[5.62, 0.00, 20.82],[8.06, 0.00, 21.61],[10.25, 0.00, 21.54],[12.11, 0.00, 20.59],[13.55, 0.00, 18.75],[14.48, 0.00, 16.09],[14.84, 0.00, 12.72],[14.55, 0.00, 8.78],[13.60, 0.00, 4.47],[12.00, 0.00, 0.00],[9.80, 0.00, -4.41],[7.10, 0.00, -8.56],[4.03, 0.00, -12.25],[0.74, 0.00, -15.33],[-2.60, 0.00, -17.69],[-5.82, 0.00, -19.28],[-8.78, 0.00, -20.07],[-11.34, 0.00, -20.08],[-13.41, 0.00, -19.35],[-14.91, 0.00, -17.95],[-15.82, 0.00, -15.96],[-16.13, 0.00, -13.45],[-15.85, 0.00, -10.51],[-15.03, 0.00, -7.23],[-13.73, 0.00, -3.69],],
  [[-12.00, 0.00, 0.00],[-9.91, 0.00, 2.60],[-7.51, 0.00, 5.18],[-4.90, 0.00, 7.69],[-2.15, 0.00, 10.03],[0.65, 0.00, 12.10],[3.42, 0.00, 13.80],[6.07, 0.00, 15.03],[8.52, 0.00, 15.71],[10.70, 0.00, 15.75],[12.51, 0.00, 15.13],[13.87, 0.00, 13.84],[14.72, 0.00, 11.91],[14.98, 0.00, 9.43],[14.62, 0.00, 6.52],[13.62, 0.00, 3.32],[12.00, 0.00, 0.00],[9.82, 0.00, -3.26],[7.17, 0.00, -6.29],[4.17, 0.00, -8.96],[0.97, 0.00, -11.15],[-2.28, 0.00, -12.78],[-5.43, 0.00, -13.83],[-8.33, 0.00, -14.28],[-10.87, 0.00, -14.18],[-12.96, 0.00, -13.56],[-14.51, 0.00, -12.50],[-15.50, 0.00, -11.04],[-15.89, 0.00, -9.27],[-15.71, 0.00, -7.22],[-14.96, 0.00, -4.96],[-13.71, 0.00, -2.54],],
  [[-12.00, 0.00, 0.00],[-9.82, 0.00, -3.26],[-7.17, 0.00, -6.29],[-4.17, 0.00, -8.96],[-0.97, 0.00, -11.15],[2.28, 0.00, -12.78],[5.43, 0.00, -13.83],[8.33, 0.00, -14.28],[10.87, 0.00, -14.18],[12.96, 0.00, -13.56],[14.51, 0.00, -12.50],[15.50, 0.00, -11.04],[15.89, 0.00, -9.27],[15.71, 0.00, -7.22],[14.96, 0.00, -4.96],[13.71, 0.00, -2.54],[12.00, 0.00, 0.00],[9.91, 0.00, 2.60],[7.51, 0.00, 5.18],[4.90, 0.00, 7.69],[2.15, 0.00, 10.03],[-0.65, 0.00, 12.10],[-3.42, 0.00, 13.80],[-6.07, 0.00, 15.03],[-8.52, 0.00, 15.71],[-10.70, 0.00, 15.75],[-12.51, 0.00, 15.13],[-13.87, 0.00, 13.84],[-14.72, 0.00, 11.91],[-14.98, 0.00, 9.43],[-14.62, 0.00, 6.52],[-13.62, 0.00, 3.32],],
  [[-12.00, 0.00, 0.00],[-9.80, 0.00, -4.41],[-7.10, 0.00, -8.56],[-4.03, 0.00, -12.25],[-0.74, 0.00, -15.33],[2.60, 0.00, -17.69],[5.82, 0.00, -19.28],[8.78, 0.00, -20.07],[11.34, 0.00, -20.08],[13.41, 0.00, -19.35],[14.91, 0.00, -17.95],[15.82, 0.00, -15.96],[16.13, 0.00, -13.45],[15.85, 0.00, -10.51],[15.03, 0.00, -7.23],[13.73, 0.00, -3.69],[12.00, 0.00, 0.00],[9.93, 0.00, 3.75],[7.58, 0.00, 7.45],[5.04, 0.00, 10.98],[2.38, 0.00, 14.21],[-0.33, 0.00, 17.01],[-3.02, 0.00, 19.26],[-5.62, 0.00, 20.82],[-8.06, 0.00, 21.61],[-10.25, 0.00, 21.54],[-12.11, 0.00, 20.59],[-13.55, 0.00, 18.75],[-14.48, 0.00, 16.09],[-14.84, 0.00, 12.72],[-14.55, 0.00, 8.78],[-13.60, 0.00, 4.47],],
  [[-12.00, 0.00, 0.00],[-9.82, 0.00, -3.26],[-7.17, 0.00, -6.29],[-4.17, 0.00, -8.96],[-0.97, 0.00, -11.15],[2.28, 0.00, -12.78],[5.43, 0.00, -13.83],[8.33, 0.00, -14.28],[10.87, 0.00, -14.18],[12.96, 0.00, -13.56],[14.51, 0.00, -12.50],[15.50, 0.00, -11.04],[15.89, 0.00, -9.27],[15.71, 0.00, -7.22],[14.96, 0.00, -4.96],[13.71, 0.00, -2.54],[12.00, 0.00, 0.00],[9.91, 0.00, 2.60],[7.51, 0.00, 5.18],[4.90, 0.00, 7.69],[2.15, 0.00, 10.03],[-0.65, 0.00, 12.10],[-3.42, 0.00, 13.80],[-6.07, 0.00, 15.03],[-8.52, 0.00, 15.71],[-10.70, 0.00, 15.75],[-12.51, 0.00, 15.13],[-13.87, 0.00, 13.84],[-14.72, 0.00, 11.91],[-14.98, 0.00, 9.43],[-14.62, 0.00, 6.52],[-13.62, 0.00, 3.32],],
]

// Rotate by Z axis
var _danceTable3 = [
  [[0.00, 8.86, 22.74],[-1.92, 9.24, 19.56],[-3.87, 9.35, 15.81],[-5.77, 9.12, 11.61],[-7.54, 8.52, 7.07],[-9.12, 7.52, 2.34],[-10.42, 6.12, -2.45],[-11.40, 4.36, -7.14],[-12.01, 2.29, -11.58],[-12.22, 0.00, -15.64],[-12.01, -2.40, -19.19],[-11.40, -4.80, -22.12],[-10.42, -7.07, -24.33],[-9.12, -9.09, -25.77],[-7.54, -10.76, -26.39],[-5.77, -11.98, -26.19],[-3.87, -12.72, -25.18],[-1.92, -12.94, -23.38],[0.00, -12.67, -20.85],[1.83, -11.95, -17.67],[3.53, -10.86, -13.93],[5.04, -9.48, -9.73],[6.34, -7.91, -5.19],[7.41, -6.24, -0.46],[8.25, -4.57, 4.33],[8.84, -2.94, 9.02],[9.20, -1.41, 13.47],[9.32, 0.00, 17.53],[9.20, 1.30, 21.08],[8.84, 2.50, 24.00],[8.25, 3.61, 26.21],[7.41, 4.66, 27.64],[6.34, 5.67, 28.27],[5.04, 6.62, 28.07],[3.53, 7.49, 27.06],[1.83, 8.25, 25.26],],
  [[0.00, 10.77, 0.94],[-1.94, 11.29, -3.04],[-3.94, 11.40, -6.90],[-5.91, 11.05, -10.54],[-7.78, 10.20, -13.84],[-9.45, 8.87, -16.71],[-10.85, 7.09, -19.05],[-11.91, 4.95, -20.78],[-12.57, 2.54, -21.84],[-12.79, 0.00, -22.20],[-12.57, -2.54, -21.84],[-11.91, -4.95, -20.78],[-10.85, -7.09, -19.05],[-9.45, -8.87, -16.71],[-7.78, -10.20, -13.84],[-5.91, -11.05, -10.54],[-3.94, -11.40, -6.90],[-1.94, -11.29, -3.04],[0.00, -10.77, 0.94],[1.82, -9.91, 4.92],[3.46, -8.81, 8.78],[4.90, -7.55, 12.42],[6.10, -6.22, 15.72],[7.08, -4.89, 18.59],[7.82, -3.59, 20.93],[8.33, -2.35, 22.66],[8.64, -1.16, 23.72],[8.74, -0.00, 24.08],[8.64, 1.16, 23.72],[8.33, 2.35, 22.66],[7.82, 3.59, 20.93],[7.08, 4.89, 18.59],[6.10, 6.22, 15.72],[4.90, 7.55, 12.42],[3.46, 8.81, 8.78],[1.82, 9.91, 4.92],],
  [[0.00, 12.67, -20.85],[-1.92, 12.94, -23.38],[-3.87, 12.72, -25.18],[-5.77, 11.98, -26.19],[-7.54, 10.76, -26.39],[-9.12, 9.09, -25.77],[-10.42, 7.07, -24.33],[-11.40, 4.80, -22.12],[-12.01, 2.40, -19.19],[-12.22, 0.00, -15.64],[-12.01, -2.29, -11.58],[-11.40, -4.36, -7.14],[-10.42, -6.12, -2.45],[-9.12, -7.52, 2.34],[-7.54, -8.52, 7.07],[-5.77, -9.12, 11.61],[-3.87, -9.35, 15.81],[-1.92, -9.24, 19.56],[0.00, -8.86, 22.74],[1.83, -8.25, 25.26],[3.53, -7.49, 27.06],[5.04, -6.62, 28.07],[6.34, -5.67, 28.27],[7.41, -4.66, 27.64],[8.25, -3.61, 26.21],[8.84, -2.50, 24.00],[9.20, -1.30, 21.08],[9.32, 0.00, 17.53],[9.20, 1.41, 13.47],[8.84, 2.94, 9.02],[8.25, 4.57, 4.33],[7.41, 6.24, -0.46],[6.34, 7.91, -5.19],[5.04, 9.48, -9.73],[3.53, 10.86, -13.93],[1.83, 11.95, -17.67],],
  [[0.00, 12.67, -20.85],[-1.83, 11.95, -17.67],[-3.53, 10.86, -13.93],[-5.04, 9.48, -9.73],[-6.34, 7.91, -5.19],[-7.41, 6.24, -0.46],[-8.25, 4.57, 4.33],[-8.84, 2.94, 9.02],[-9.20, 1.41, 13.47],[-9.32, 0.00, 17.53],[-9.20, -1.30, 21.08],[-8.84, -2.50, 24.00],[-8.25, -3.61, 26.21],[-7.41, -4.66, 27.64],[-6.34, -5.67, 28.27],[-5.04, -6.62, 28.07],[-3.53, -7.49, 27.06],[-1.83, -8.25, 25.26],[0.00, -8.86, 22.74],[1.92, -9.24, 19.56],[3.87, -9.35, 15.81],[5.77, -9.12, 11.61],[7.54, -8.52, 7.07],[9.12, -7.52, 2.34],[10.42, -6.12, -2.45],[11.40, -4.36, -7.14],[12.01, -2.29, -11.58],[12.22, 0.00, -15.64],[12.01, 2.40, -19.19],[11.40, 4.80, -22.12],[10.42, 7.07, -24.33],[9.12, 9.09, -25.77],[7.54, 10.76, -26.39],[5.77, 11.98, -26.19],[3.87, 12.72, -25.18],[1.92, 12.94, -23.38],],
  [[0.00, 10.77, 0.94],[-1.82, 9.91, 4.92],[-3.46, 8.81, 8.78],[-4.90, 7.55, 12.42],[-6.10, 6.22, 15.72],[-7.08, 4.89, 18.59],[-7.82, 3.59, 20.93],[-8.33, 2.35, 22.66],[-8.64, 1.16, 23.72],[-8.74, 0.00, 24.08],[-8.64, -1.16, 23.72],[-8.33, -2.35, 22.66],[-7.82, -3.59, 20.93],[-7.08, -4.89, 18.59],[-6.10, -6.22, 15.72],[-4.90, -7.55, 12.42],[-3.46, -8.81, 8.78],[-1.82, -9.91, 4.92],[0.00, -10.77, 0.94],[1.94, -11.29, -3.04],[3.94, -11.40, -6.90],[5.91, -11.05, -10.54],[7.78, -10.20, -13.84],[9.45, -8.87, -16.71],[10.85, -7.09, -19.05],[11.91, -4.95, -20.78],[12.57, -2.54, -21.84],[12.79, -0.00, -22.20],[12.57, 2.54, -21.84],[11.91, 4.95, -20.78],[10.85, 7.09, -19.05],[9.45, 8.87, -16.71],[7.78, 10.20, -13.84],[5.91, 11.05, -10.54],[3.94, 11.40, -6.90],[1.94, 11.29, -3.04],],
  [[0.00, 8.86, 22.74],[-1.83, 8.25, 25.26],[-3.53, 7.49, 27.06],[-5.04, 6.62, 28.07],[-6.34, 5.67, 28.27],[-7.41, 4.66, 27.64],[-8.25, 3.61, 26.21],[-8.84, 2.50, 24.00],[-9.20, 1.30, 21.08],[-9.32, 0.00, 17.53],[-9.20, -1.41, 13.47],[-8.84, -2.94, 9.02],[-8.25, -4.57, 4.33],[-7.41, -6.24, -0.46],[-6.34, -7.91, -5.19],[-5.04, -9.48, -9.73],[-3.53, -10.86, -13.93],[-1.83, -11.95, -17.67],[0.00, -12.67, -20.85],[1.92, -12.94, -23.38],[3.87, -12.72, -25.18],[5.77, -11.98, -26.19],[7.54, -10.76, -26.39],[9.12, -9.09, -25.77],[10.42, -7.07, -24.33],[11.40, -4.80, -22.12],[12.01, -2.40, -19.19],[12.22, 0.00, -15.64],[12.01, 2.29, -11.58],[11.40, 4.36, -7.14],[10.42, 6.12, -2.45],[9.12, 7.52, 2.34],[7.54, 8.52, 7.07],[5.77, 9.12, 11.61],[3.87, 9.35, 15.81],[1.92, 9.24, 19.56],],
]

function _dance(leg, time, params, loc) {

  var N = params.table[0].length
  if(time >= N)
    time = 0
  var ref = params.table[leg][time]

  loc[0] = ref[0]
  loc[1] = ref[1]
  loc[2] = ref[2]

  return (time+N+1)%(N)
}

var _fwdTable = [
  [0, -20, 0],  [6, -19, 6],  [12, -16, 12],  [16, -12, 16],  [19, -6, 19],
  [20, 0, 20],  [19, 6, 19],  [16, 12, 16],  [12, 16, 12],  [6, 19, 6],
  [0, 20, 0],  [0, 16, 0],  [0, 12, 0],  [0, 8, 0],  [0, 4, 0],
  [0, 0, 0],  [0, -4, 0],  [0, -8, 0],  [0, -12, 0],  [0, -16, 0],
]

function _fwd(leg, time, params, loc) {
  var N = params.table.length
  var offset = N/4;

  if(leg % 2 == 1) offset += N/2

  var ref = params.table[(time + offset) % N]

  if(leg < 3)
    loc[0] = ref[0]
  else
    loc[0] = -ref[0]
  loc[1] = ref[1]
  loc[2] = ref[2]

  if(params.dir)
    return (time+1)%[N]
  else
    return (time+N-1)%[N]
}

function _shift(leg, time, params, loc) {
  var N = params.table.length
  var offset = 0;

  if(leg % 2 == 1) offset += N/2

  var ref = params.table[(time + offset) % N]

  loc[0] = ref[1]/1.5
  loc[1] = 0
  loc[2] = ref[2]

  if(params.dir)
    return (time+1)%[N]
  else
    return (time+N-1)%[N]
}

var _turnTable = [
  [[20.35, -18.49, 0.00],[16.54, -14.52, 4.00],[12.60, -10.67, 8.00],[8.52, -6.97, 12.00],[4.32, -3.41, 16.00],[0.00, 0.00, 20.00],[-4.44, 3.26, 16.00],[-8.99, 6.36, 12.00],[-13.64, 9.30, 8.00],[-18.40, 12.07, 4.00],[-23.25, 14.68, 0.00],[-18.40, 12.07, 0.00],[-13.64, 9.30, 0.00],[-8.99, 6.36, 0.00],[-4.44, 3.26, 0.00],[0.00, 0.00, 0.00],[4.32, -3.41, 0.00],[8.52, -6.97, 0.00],[12.60, -10.67, 0.00],[16.54, -14.52, 0.00],],
  [[-2.02, -23.14, 0.00],[-1.30, -18.54, 4.00],[-0.73, -13.93, 8.00],[-0.32, -9.30, 12.00],[-0.08, -4.65, 16.00],[0.00, 0.00, 20.00],[-0.08, 4.65, 16.00],[-0.32, 9.30, 12.00],[-0.73, 13.93, 8.00],[-1.30, 18.54, 4.00],[-2.02, 23.14, 0.00],[-1.30, 18.54, 0.00],[-0.73, 13.93, 0.00],[-0.32, 9.30, 0.00],[-0.08, 4.65, 0.00],[0.00, 0.00, 0.00],[-0.08, -4.65, 0.00],[-0.32, -9.30, 0.00],[-0.73, -13.93, 0.00],[-1.30, -18.54, 0.00],],
  [[-23.25, -14.68, 0.00],[-18.40, -12.07, 4.00],[-13.64, -9.30, 8.00],[-8.99, -6.36, 12.00],[-4.44, -3.26, 16.00],[0.00, 0.00, 20.00],[4.32, 3.41, 16.00],[8.52, 6.97, 12.00],[12.60, 10.67, 8.00],[16.54, 14.52, 4.00],[20.35, 18.49, 0.00],[16.54, 14.52, 0.00],[12.60, 10.67, 0.00],[8.52, 6.97, 0.00],[4.32, 3.41, 0.00],[0.00, 0.00, 0.00],[-4.44, -3.26, 0.00],[-8.99, -6.36, 0.00],[-13.64, -9.30, 0.00],[-18.40, -12.07, 0.00],],
  [[-20.35, 18.49, 0.00],[-16.54, 14.52, 4.00],[-12.60, 10.67, 8.00],[-8.52, 6.97, 12.00],[-4.32, 3.41, 16.00],[0.00, 0.00, 20.00],[4.44, -3.26, 16.00],[8.99, -6.36, 12.00],[13.64, -9.30, 8.00],[18.40, -12.07, 4.00],[23.25, -14.68, 0.00],[18.40, -12.07, 0.00],[13.64, -9.30, 0.00],[8.99, -6.36, 0.00],[4.44, -3.26, 0.00],[0.00, 0.00, 0.00],[-4.32, 3.41, 0.00],[-8.52, 6.97, 0.00],[-12.60, 10.67, 0.00],[-16.54, 14.52, 0.00],],
  [[2.02, 23.14, 0.00],[1.30, 18.54, 4.00],[0.73, 13.93, 8.00],[0.32, 9.30, 12.00],[0.08, 4.65, 16.00],[0.00, 0.00, 20.00],[0.08, -4.65, 16.00],[0.32, -9.30, 12.00],[0.73, -13.93, 8.00],[1.30, -18.54, 4.00],[2.02, -23.14, 0.00],[1.30, -18.54, 0.00],[0.73, -13.93, 0.00],[0.32, -9.30, 0.00],[0.08, -4.65, 0.00],[0.00, 0.00, 0.00],[0.08, 4.65, 0.00],[0.32, 9.30, 0.00],[0.73, 13.93, 0.00],[1.30, 18.54, 0.00],],
  [[23.25, 14.68, 0.00],[18.40, 12.07, 4.00],[13.64, 9.30, 8.00],[8.99, 6.36, 12.00],[4.44, 3.26, 16.00],[0.00, 0.00, 20.00],[-4.32, -3.41, 16.00],[-8.52, -6.97, 12.00],[-12.60, -10.67, 8.00],[-16.54, -14.52, 4.00],[-20.35, -18.49, 0.00],[-16.54, -14.52, 0.00],[-12.60, -10.67, 0.00],[-8.52, -6.97, 0.00],[-4.32, -3.41, 0.00],[0.00, 0.00, 0.00],[4.44, 3.26, 0.00],[8.99, 6.36, 0.00],[13.64, 9.30, 0.00],[18.40, 12.07, 0.00],],
]

function _turn(leg, time, params, loc) {

  var N = params.table[0].length
  var offset = N/4;

  if(leg % 2 == 1) offset += N/2

  var ref = params.table[leg][(time + offset) % N]

  loc[0] = ref[0]
  loc[1] = ref[1]
  loc[2] = ref[2]

  if(params.dir)
    return (time+N+1)%(N)
  else
    return (time+N-1)%(N)
}

var _mode = {
  "adj": {func: _adjust, params: {},},
  "s" : {func: _stop, params: {},},
  "d1" : {func: _dance, params: {table: _danceTable1},},
  "d2" : {func: _dance, params: {table: _danceTable2},},
  "d3" : {func: _dance, params: {table: _danceTable3},},
  "fwd": {func: _fwd, params: {table: _fwdTable, dir: true, },},
  "bwd": {func: _fwd, params: {table: _fwdTable, dir: false, },},
  "sl": {func: _shift, params: {table: _fwdTable, dir: false, },},
  "sr": {func: _shift, params: {table: _fwdTable, dir: true, },},
  "tl": {func: _turn, params: {table: _turnTable, dir: true, },},
  "tr": {func: _turn, params: {table: _turnTable, dir: false, },},
}

var stepDelay = settings.stepDelay
var currMode
var currTimeslot = 0         // current time
var _switchTable = []

var nextTimer = undefined
var switchTimer = undefined

if(DEBUG_EMU)
  stepDelay = 1000

function _next() {

  if(_switchTable.length != 0)  // during switching
    return

  var nextTimeslot;
  var loc = [0, 0, 0]

  for(var leg=0;leg<6;leg++) 
  {
    nextTimeslot = _mode[currMode].func(leg, currTimeslot, _mode[currMode].params, loc)

    loc[0] += legTipsDefault[leg][0]
    loc[1] += legTipsDefault[leg][1]
    loc[2] += legTipsDefault[leg][2]

    if(DEBUG_EMU)
      console.log("Slot[" + currTimeslot + "]Leg[" + (leg+1) + "]" + loc[0] + "," + loc[1] + "," + loc[2])

    moveLeg(leg, loc)

  }
  currTimeslot = nextTimeslot
  nextTimer = setTimeout(_next, stepDelay)
}

function _switching()
{
  if(_switchTable.length == 0)
  {
    if(DEBUG)
      console.log("[log]done switch")
    // end of switching, back to mode 
    _next()
    return;
  }

  if(DEBUG)
    console.log("[log]switching" + _switchTable.length)
  locs = _switchTable.pop()

  for(i=0;i<6;i++)
  {
    var loc = locs[i].slice()
    loc[0] += legTipsDefault[i][0]
    loc[1] += legTipsDefault[i][1]
    loc[2] += legTipsDefault[i][2]
    moveLeg(i, loc)
  }

  switchTimer = setTimeout(_switching, stepDelay)
}

function _switch(mode) {

  if(currMode == mode)
    return

  if(DEBUG)
    console.log("switching from " + currMode + " to " + mode)

  if(switchTimer != undefined)
    clearTimeout(switchTimer)

  if(nextTimer != undefined)
    clearTimeout(nextTimer)

  currMode = mode
  currTimeslot = 0

  // prepare for the path of switching
  const switchSteps = settings.switchSteps

  var leg
  var starts = []
  var ends = []
  var steps = []
  for(leg=0;leg<6;leg++)
  {
    // start pt
    var s = getLegsLoc(leg)
    s[0] -= legTipsDefault[leg][0]
    s[1] -= legTipsDefault[leg][1]
    s[2] -= legTipsDefault[leg][2]

    // end pt
    var e = [0, 0, 0]
    _mode[currMode].func(leg, 0, _mode[currMode].params, e)

    // diff
    var d = [(s[0]-e[0])/switchSteps, (s[1]-e[1])/switchSteps, (s[2]-e[2])/switchSteps]

    starts.push(s)
    ends.push(e)
    steps.push(d)
  }
  _switchTable = []
  // generating path
  _switchTable.push(ends)
  for(var t=1;t<=switchSteps;t++)
  {
    pts = []
    for(leg=0;leg<6;leg++)
    {
      pt = ends[leg].slice()
      pt[0] += steps[leg][0]*t
      pt[1] += steps[leg][1]*t
      pt[2] += steps[leg][2]*t
      pts.push(pt)
    }
    _switchTable.push(pts)
  }

  _switching()
}

function _adjustLeg(leg, part, value)
{
  if(leg >= 0)
    settings.pinDefaultPWM[leg][part] = pwm
  console.log(settings.pinDefaultPWM)
}

var _testServoData = [0, 0, 0, 0]
var _testServoTimer

function _testServoCB()
{
  leg = _testServoData[0]
  part = _testServoData[1]
  nextvalue = _testServoData[2] + _testServoData[3]
  _testServoData[2] = nextvalue
  if(nextvalue >= 500 || nextvalue <= -500)
    _testServoData[3] = -_testServoData[3]

  console.log(_testServoData)
  writePwm(settings.pinMap[leg][part], 1500+nextvalue)
  _testServoTimer = setTimeout(_testServoCB, 1000)
}

function _testServo(leg, part)
{
  clearTimeout(_testServoTimer)
  _testServoData[0] = leg
  _testServoData[1] = part
  _testServoData[2] = 0
  _testServoData[3] = 100
  _testServoTimer = setTimeout(_testServoCB, 1000)
}

function init()
{
  function sleep(ms) {
    var start = new Date().getTime();
    while(new Date().getTime() < start + ms);
  }

  for(leg=0;leg<6;leg++)
    moveLeg(leg, legTipsDefault[leg])
  currMode = _modeTable.modeStop  
  sleep(1000)

  if(!DEBUG_EMU)
    pGood.write(1)
}

module.exports = {
  init: init,
  command: _switch,
  mode: _modeTable,
  adjustLeg: _adjustLeg,
  testServo: _testServo,
}






