from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN
from .options_flow import EnvironmentalSchedulerOptionsFlow


class EnvironmentalSchedulerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    @staticmethod
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        return EnvironmentalSchedulerOptionsFlow(config_entry)

    async def async_step_user(self, user_input: dict | None = None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="Environmental Scheduler", data={})

        return self.async_show_form(step_id="user")
