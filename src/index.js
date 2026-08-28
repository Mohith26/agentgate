'use strict';

module.exports = Object.assign({},
  require('./store'),
  require('./query'),
  require('./sharing'),
  require('./limits'),
  require('./actions'),
  require('./telemetry'),
  require('./runtime'),
  require('./seed')
);
