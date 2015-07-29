'use strict';

angular.module('esn.calendar')

  .factory('calendarEventSource', function($log, calendarService) {
    return function(calendarId, errorCallback) {
      return function(start, end, timezone, callback) {
        $log.debug('Getting events for %s', calendarId);
        var path = '/calendars/' + calendarId + '/events';
        return calendarService.list(path, start, end, timezone).then(
          function(events) {
            callback(events.filter(function(calendarShell) {
              return !calendarShell.status || calendarShell.status !== 'CANCELLED';
            }));
          },
          function(err) {
            callback([]);
            $log.error(err);
            if (errorCallback) {
              errorCallback(err, 'Can not get calendar events');
            }
          });
      };
    };
  })

  .factory('request', function($http, $q, DAV_PATH) {
    function _configureRequest(method, path, headers, body, params) {
      var url = DAV_PATH;

      headers = headers || {};

      var config = {
        url: url + path,
        method: method,
        headers: headers,
        params: params
      };

      if (body) {
        config.data = body;
      }

      return $q.when(config);
    }

    function request(method, path, headers, body, params) {
      return _configureRequest(method, path, headers, body, params).then($http);
    }

    return request;
  })

  .factory('calendarEventEmitter', function($rootScope, $q, socket) {
    var websocket = socket('/calendars');

    return {
      activitystream: {
        emitPostedMessage: function(messageId, activityStreamUuid) {
          $rootScope.$emit('message:posted', {
            activitystreamUuid: activityStreamUuid,
            id: messageId
          });
        }
      },
      fullcalendar: {
        emitCreatedEvent: function(shell) {
          $rootScope.$emit('addedCalendarItem', shell);
        },
        emitRemovedEvent: function(id) {
          $rootScope.$emit('removedCalendarItem', id);
        },
        emitModifiedEvent: function(shell) {
          $rootScope.$emit('modifiedCalendarItem', shell);
        }
      },
      websocket: {
        emitCreatedEvent: function(vcalendar) {
          websocket.emit('event:created', vcalendar);
        },
        emitRemovedEvent: function(vcalendar) {
          websocket.emit('event:deleted', vcalendar);
        }
      }
    };
  })

  .factory('calendarService', function($rootScope, $q, request, moment, jstz, uuid4, socket, calendarEventEmitter, calendarUtils, gracePeriodService, ICAL, ICAL_PROPERTIES, CALENDAR_GRACE_DELAY) {
    /**
     * A shell that wraps an ical.js VEVENT component to be compatible with
     * fullcalendar's objects.
     *
     * @param {ICAL.Component} vcalendar     The ical.js VCALENDAR component.
     * @param {String} path                  The path on the caldav server.
     * @param {String} etag                  The ETag of the event.
     * @param {String} gracePeriodTaskId     The gracePeriodTaskId of the event.
     */
    function CalendarShell(vcalendar, path, etag, gracePeriodTaskId) {
      var vevent = vcalendar.getFirstSubcomponent('vevent');
      this.id = vevent.getFirstPropertyValue('uid');
      this.title = vevent.getFirstPropertyValue('summary');
      this.location = vevent.getFirstPropertyValue('location');
      this.description = vevent.getFirstPropertyValue('description');
      this.allDay = vevent.getFirstProperty('dtstart').type === 'date';
      this.start = moment(vevent.getFirstPropertyValue('dtstart').toJSDate());
      this.end = moment(vevent.getFirstPropertyValue('dtend').toJSDate());
      this.formattedDate = this.start.format('MMMM D, YYYY');
      this.formattedStartTime = this.start.format('h');
      this.formattedStartA = this.start.format('a');
      this.formattedEndTime = this.end.format('h');
      this.formattedEndA = this.end.format('a');
      var status = vevent.getFirstPropertyValue('status');
      if (status) {
        this.status = status;
      }

      var attendees = this.attendees = [];

      vevent.getAllProperties('attendee').forEach(function(att) {
        var id = att.getFirstValue();
        if (!id) {
          return;
        }
        var cn = att.getParameter('cn');
        var mail = calendarUtils.removeMailto(id);
        var partstat = att.getParameter('partstat');
        attendees.push({
          fullmail: calendarUtils.fullmailOf(cn, mail),
          email: mail,
          name: cn || mail,
          partstat: partstat,
          displayName: cn || mail
        });
      });

      var organizer = vevent.getFirstProperty('organizer');
      if (organizer) {
        var mail = calendarUtils.removeMailto(organizer.getFirstValue());
        var cn = organizer.getParameter('cn');
        this.organizer = {
          fullmail: calendarUtils.fullmailOf(cn, mail),
          email: mail,
          name: cn || mail,
          displayName: cn || mail
        };
      }

      // NOTE: changing any of the above properties won't update the vevent, or
      // vice versa.
      this.vcalendar = vcalendar;
      this.path = path;
      this.etag = etag;
      this.gracePeriodTaskId = gracePeriodTaskId;
    }

    var timezoneLocal = this.timezoneLocal || jstz.determine().name();

    function shellToICAL(shell) {
      var uid = shell.id || uuid4.generate();
      var vcalendar = new ICAL.Component('vcalendar');
      var vevent = new ICAL.Component('vevent');
      vevent.addPropertyWithValue('uid', uid);
      vevent.addPropertyWithValue('summary', shell.title);

      var dtstart = ICAL.Time.fromJSDate(shell.start.toDate());
      var dtend = ICAL.Time.fromJSDate(shell.end.toDate());

      dtstart.isDate = shell.allDay;
      dtend.isDate = shell.allDay;

      if (shell.organizer) {
        var organizer = vevent.addPropertyWithValue('organizer', calendarUtils.prependMailto(shell.organizer.email || shell.organizer.emails[0]));
        organizer.setParameter('cn', shell.organizer.displayName || calendarUtils.displayNameOf(shell.organizer.firstname, shell.organizer.lastname));
      }

      vevent.addPropertyWithValue('dtstart', dtstart).setParameter('tzid', timezoneLocal);
      vevent.addPropertyWithValue('dtend', dtend).setParameter('tzid', timezoneLocal);
      vevent.addPropertyWithValue('transp', shell.allDay ? 'TRANSPARENT' : 'OPAQUE');

      if (shell.location) {
        vevent.addPropertyWithValue('location', shell.location);
      }

      if (shell.description) {
        vevent.addPropertyWithValue('description', shell.description);
      }

      if (shell.attendees && shell.attendees.length) {
        shell.attendees.forEach(function(attendee) {
          var mail = attendee.email || attendee.emails[0];
          var mailto = calendarUtils.prependMailto(mail);
          var property = vevent.addPropertyWithValue('attendee', mailto);
          property.setParameter('partstat', attendee.partstat || ICAL_PROPERTIES.partstat.needsaction);
          property.setParameter('rsvp', ICAL_PROPERTIES.rsvp.true);
          property.setParameter('role', ICAL_PROPERTIES.role.reqparticipant);
          if (attendee.displayName && attendee.displayName !== mail) {
            property.setParameter('cn', attendee.displayName);
          }
        });
      }

      vcalendar.addSubcomponent(vevent);
      return vcalendar;
    }

    function icalToShell(ical) {
      return new CalendarShell(new ICAL.Component(ical));
    }

    function getInvitedAttendees(vcalendar, emails) {
      var vevent = vcalendar.getFirstSubcomponent('vevent');
      var attendees = vevent.getAllProperties('attendee');
      var organizer = vevent.getFirstProperty('organizer');
      var organizerId = organizer && organizer.getFirstValue().toLowerCase();

      var emailMap = Object.create(null);
      emails.forEach(function(email) { emailMap[calendarUtils.prependMailto(email.toLowerCase())] = true; });

      var invitedAttendees = [];
      for (var i = 0; i < attendees.length; i++) {
        if (attendees[i].getFirstValue().toLowerCase() in emailMap) {
          invitedAttendees.push(attendees[i]);
        }
      }

      // We also need the organizer to work around an issue in Lightning
      if (organizer && organizerId in emailMap) {
        invitedAttendees.push(organizer);
      }
      return invitedAttendees;
    }

    function getEvent(path) {
      var headers = { Accept: 'application/calendar+json' };
      return request('get', path, headers).then(function(response) {
        if (response.status !== 200) {
          return $q.reject(response);
        }
        var vcalendar = new ICAL.Component(response.data);
        return new CalendarShell(vcalendar, path, response.headers('ETag'));
      });
    }

    function list(calendarPath, start, end, timezone) {
      var req = {
        match: {
          start: moment(start).format('YYYYMMDD[T]HHmmss'),
          end: moment(end).format('YYYYMMDD[T]HHmmss')
        }
      };

      return request('post', calendarPath + '.json', null, req).then(function(response) {
        if (!response.data || !response.data._embedded || !response.data._embedded['dav:item']) {
          return [];
        }
        return response.data._embedded['dav:item'].map(function(icaldata) {
          var vcalendar = new ICAL.Component(icaldata.data);
          return new CalendarShell(vcalendar, icaldata._links.self.href, icaldata.etag);
        });
      });
    }

    function create(calendarPath, vcalendar) {
      var vevent = vcalendar.getFirstSubcomponent('vevent');
      if (!vevent) {
        return $q.reject(new Error('Missing VEVENT in VCALENDAR'));
      }
      var uid = vevent.getFirstPropertyValue('uid');
      if (!uid) {
        return $q.reject(new Error('Missing UID in VEVENT'));
      }

      var eventPath = calendarPath.replace(/\/$/, '') + '/' + uid + '.ics';
      var headers = { 'Content-Type': 'application/calendar+json' };
      var body = vcalendar.toJSON();

      var taskId = null;
      return request('put', eventPath, headers, body, { graceperiod: CALENDAR_GRACE_DELAY })
        .then(function(response) {
          if (response.status !== 202) {
            return $q.reject(response);
          }
          taskId = response.data.id;
          calendarEventEmitter.fullcalendar.emitCreatedEvent(new CalendarShell(vcalendar, null, null, taskId));
        })
        .then(function() {
          return gracePeriodService.grace(taskId, 'You are about to create a new event (' + vevent.getFirstPropertyValue('summary') + ').', 'Cancel it', CALENDAR_GRACE_DELAY);
        })
        .then(function(data) {
          var task = data;
          if (task.cancelled) {
            gracePeriodService.cancel(taskId).then(function() {
              calendarEventEmitter.fullcalendar.emitRemovedEvent(uid);
              task.success();
            }, function(err) {
              task.error(err.statusText);
            });
          } else {
            // Unfortunately, sabredav doesn't support Prefer:
            // return=representation on the PUT request,
            // so we have to retrieve the event again for the etag.
            return getEvent(eventPath).then(function(shell) {
              gracePeriodService.remove(taskId);
              calendarEventEmitter.fullcalendar.emitModifiedEvent(shell);
              calendarEventEmitter.websocket.emitCreatedEvent(shell.vcalendar);
              return shell;
            }, function(response) {
              if (response.status === 404) {
                // Silently fail here because it is due to
                // the task being cancelled by another method.
                return;
              } else {
                return response;
              }
            });
          }
        });
    }

    function remove(path, event, etag) {
      var headers = {};
      if (etag) {
        headers['If-Match'] = etag;
      } else {
        // This is a noop and the event is not created yet in sabre/dav,
        // we then should only remove the event from fullcalendar
        // and cancel the taskid corresponding on the event.
        return gracePeriodService.cancel(event.gracePeriodTaskId).then(function() {
          calendarEventEmitter.fullcalendar.emitRemovedEvent(event.id);
        }, $q.reject);
      }

      var taskId = null;
      var vcalendar = shellToICAL(event);
      var shell = new CalendarShell(vcalendar, path, etag);
      return request('delete', path, headers, null, { graceperiod: CALENDAR_GRACE_DELAY }).then(function(response) {
        if (response.status !== 202) {
          return $q.reject(response);
        }
        taskId = response.data.id;
        calendarEventEmitter.fullcalendar.emitRemovedEvent(shell.id);
      })
      .then(function() {
        return gracePeriodService.grace(taskId, 'You are about to delete the event (' + event.title + ').', 'Cancel it', CALENDAR_GRACE_DELAY);
      })
      .then(function(data) {
        var task = data;
        if (task.cancelled) {
          gracePeriodService.cancel(taskId).then(function() {
            calendarEventEmitter.fullcalendar.emitCreatedEvent(shell);
            task.success();
          }, function(err) {
            task.error(err.statusText);
          });
        } else {
          gracePeriodService.remove(taskId);
          calendarEventEmitter.websocket.emitRemovedEvent(vcalendar);
        }
      });
    }

    function modify(eventPath, event, etag) {
      var headers = {
        'Content-Type': 'application/calendar+json',
        'Prefer': 'return=representation'
      };
      var body = shellToICAL(event).toJSON();

      if (etag) {
        headers['If-Match'] = etag;
      }

      return request('put', eventPath, headers, body).then(function(response) {
        if (response.status === 200) {
          var vcalendar = new ICAL.Component(response.data);
          return new CalendarShell(vcalendar, eventPath, response.headers('ETag'));
        } else if (response.status === 204) {
          return getEvent(eventPath).then(function(shell) {
            $rootScope.$emit('modifiedCalendarItem', shell);
            socket('/calendars').emit('event:updated', shell.vcalendar);
            return shell;
          });
        } else {
          return $q.reject(response);
        }
      });
    }

    function changeParticipation(eventPath, event, emails, status, etag) {
      var emailMap = Object.create(null);
      var needsModify = false;

      emails.forEach(function(email) { emailMap[email.toLowerCase()] = true; });
      event.attendees.forEach(function(attendee) {
        if ((attendee.email.toLowerCase() in emailMap) && attendee.partstat !== status) {
          attendee.partstat = status;
          needsModify = true;
        }
      });
      if (!needsModify) {
        return $q.when(null);
      }

      return modify(eventPath, event, etag)['catch'](function(response) {
        if (response.status === 412) {
          return getEvent(eventPath).then(function(shell) {
            // A conflict occurred. We've requested the event data in the
            // response, so we can retry the request with this data.
            return changeParticipation(eventPath, shell, emails, status, shell.etag);
          });
        } else {
          return $q.reject(response);
        }
      });
    }

    return {
      list: list,
      create: create,
      remove: remove,
      modify: modify,
      changeParticipation: changeParticipation,
      getEvent: getEvent,
      shellToICAL: shellToICAL,
      icalToShell: icalToShell,
      timezoneLocal: timezoneLocal,
      getInvitedAttendees: getInvitedAttendees
    };
  })

  .service('eventService', function(session, ICAL) {
    function render(event, element) {
      element.find('.fc-content').addClass('ellipsis');

      if (event.location) {
        var contentElement = element.find('.fc-title');
        contentElement.addClass('ellipsis');
        var contentHtml = contentElement.html() + ' (' + event.location + ')';
        contentElement.html(contentHtml);
      }

      if (event.description) {
        element.attr('title', event.description);
      }

      var invitedAttendee = null;
      if (event.attendees) {
        event.attendees.forEach(function(att) {
          if (att.email in session.user.emailMap) {
            invitedAttendee = att;
          }
        });
      }

      if (invitedAttendee && (invitedAttendee.partstat === 'NEEDS-ACTION' || invitedAttendee.partstat === 'TENTATIVE')) {
        element.addClass('event-needs-action');
      } else {
        element.addClass('event-accepted');
      }

      element.addClass('event-common');
    }

    function copyEventObject(src, dest) {

      var vcal;
      if (src.vcalendar) {
        vcal = ICAL.helpers.clone(src.vcalendar);
        src.vcalendar = null;
      }
      angular.copy(src, dest);
      if (vcal) {
        src.vcalendar = vcal;
        dest.vcalendar = vcal;
      }
    }

    function isOrganizer(event) {
      var organizerMail = event && event.organizer && (event.organizer.email || event.organizer.emails[0]);
      return !organizerMail || (organizerMail in session.user.emailMap);
    }

    return {
      render: render,
      copyEventObject: copyEventObject,
      isOrganizer: isOrganizer
    };

  })

  .service('calendarUtils', function(moment) {
    /**
     * Prepend a mail with 'mailto:'
     * @param {String} mail
     */
    function prependMailto(mail) {
      return 'mailto:' + mail;
    }

    /**
     * Remove (case insensitive) mailto: prefix
     * @param {String} mail
     */
    function removeMailto(mail) {
      return mail.replace(/^mailto:/i, '');
    }

    /**
     * Build and return a fullname like: John Doe <john.doe@open-paas.org>
     * @param {String} cn
     * @param {String} mail
     */
    function fullmailOf(cn, mail) {
      return cn ? cn + ' <' + mail + '>' : mail;
    }

    /**
     * Build and return a displayName: 'firstname lastname'
     * @param {String} firstname
     * @param {String} lastname
     */
    function displayNameOf(firstname, lastname) {
      return firstname + ' ' + lastname;
    }

    /**
     * Return a moment representing (the next hour) starting from Date.now()
     */
    function getNewStartDate() {
      return moment().endOf('hour').add(1, 'seconds');
    }

    /**
     * Return a moment representing (the next hour + 1 hour) starting from Date.now()
     */
    function getNewEndDate() {
      return getNewStartDate().add(1, 'hours');
    }

    /**
     * Return true if start is the same day than end
     * @param {Date} start
     * @param {Date} end
     */
    function isSameDay(start, end) {
      return start.isSame(end, 'day');
    }

    /**
     * When selecting a single cell, ensure that the end date is 1 hours more than the start date at least.
     * @param {Date} start
     * @param {Date} end
     */
    function getDateOnCalendarSelect(start, end) {
      if (end.diff(start, 'minutes') === 30) {
        var newStart = start.startOf('hour');
        var newEnd = moment(newStart).add(1, 'hours');
        return { start: newStart, end: newEnd };
      } else {
        return { start: start, end: end };
      }
    }

    return {
      prependMailto: prependMailto,
      removeMailto: removeMailto,
      fullmailOf: fullmailOf,
      displayNameOf: displayNameOf,
      getNewStartDate: getNewStartDate,
      getNewEndDate: getNewEndDate,
      isSameDay: isSameDay,
      getDateOnCalendarSelect: getDateOnCalendarSelect
    };
  });
